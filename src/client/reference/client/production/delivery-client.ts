/**
 * Cancellable, incremental delivery poller.
 *
 * One poll is `GET /reference/deliveries?sessionId=<current>&since=<cursor>`.
 * The cursor is supplied per session by the caller (persisted by the runtime),
 * so switching sessions cannot leak another conversation's deliveries into the
 * current draft. Polling is cancellable: `stop`, `setSession` and `dispose`
 * abort the in-flight request (via the shared cancellation source) and bump a
 * generation token so a late response is dropped. Full frozen snapshots in the
 * response let the runtime restore cards after a page close / DSH restart.
 *
 * @module dsh-browser-reference/production/delivery-client
 */
import type { DeliveriesResponse } from './protocol.ts'
import type { ReferenceHttpClient } from './http-transport.ts'

/** Shared abort source so the http client and the poller agree on cancellation. */
export interface CancellationSource {
  /** Current signal handed to every in-flight request. */
  signal(): AbortSignal
  /** Abort the current request and open a fresh signal. */
  reset(): void
  /** Abort permanently (dispose). */
  abort(): void
}

export function createCancellationSource(): CancellationSource {
  let controller = new AbortController()
  let dead = false
  return {
    signal: () => controller.signal,
    reset() {
      if (dead) return
      controller.abort()
      controller = new AbortController()
    },
    abort() {
      dead = true
      controller.abort()
    },
  }
}

export interface PollerScheduler {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const liveScheduler: PollerScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface DeliveryPollerOptions {
  readonly http: ReferenceHttpClient
  readonly getSessionId: () => string
  readonly getSince: () => number
  /**
   * Apply one response. The optional `isActive` lets the runtime stop touching
   * the OLD session's draft/ACKs when a session switch lands mid-cycle.
   */
  readonly onCycle: (response: DeliveriesResponse, sessionId: string, isActive?: () => boolean) => Promise<void> | void
  /**
   * Fired once per settled poll (success, cycle error or network failure),
   * ONLY while its generation is still active. The runtime uses it to publish
   * the dock even when `onCycle` never ran — the failure paths that used to
   * leave a cached "ok" banner on screen forever.
   */
  readonly onSettled?: () => void
  readonly intervalMs?: number
  readonly scheduler?: PollerScheduler
  /** Abort source shared with the http client; created internally when absent. */
  readonly cancellation?: CancellationSource
}

export interface DeliveryPoller {
  /** Run exactly one poll cycle; returns the response or undefined when cancelled/failed. */
  pollOnce(): Promise<DeliveriesResponse | undefined>
  start(): void
  stop(): void
  dispose(): void
  /** Switch the active session; cancels any in-flight request. */
  setSession(sessionId: string): void
  isPolling(): boolean
  readonly disposed: boolean
  readonly lastError: unknown
  readonly cancellation: CancellationSource
}

/** Build the poller; `start()` schedules the interval and fires one immediate poll. */
export function createDeliveryPoller(options: DeliveryPollerOptions): DeliveryPoller {
  const http = options.http
  const scheduler = options.scheduler ?? liveScheduler
  const interval = options.intervalMs ?? 1500
  const cancellation = options.cancellation ?? createCancellationSource()
  let generation = 0
  let polling = false
  let disposed = false
  let handle: unknown
  let lastError: unknown

  const active = (token: number): boolean => !disposed && token === generation

  /**
   * One HTTP request in flight at a time.
   *
   * The interval, a focus/visibility wake-up and a manual poll can all fire in
   * the same tick. Without this guard they read the SAME `since`, process the
   * SAME deliveries twice and race to write the cursor: a retryable delivery
   * can be skipped past by the later write and never reach the composer again.
   */
  let inFlight: Promise<DeliveriesResponse | undefined> | undefined

  /**
   * Stop the interval and cancel the in-flight request.
   *
   * A closure, not a method: `dispose()` is also called detached (a React
   * cleanup or a destructured handle), where `this` is not the poller.
   */
  const stop = (): void => {
    polling = false
    generation += 1
    cancellation.reset()
    inFlight = undefined
    if (handle !== undefined) { scheduler.clearInterval(handle); handle = undefined }
  }

  const runPoll = async (): Promise<DeliveriesResponse | undefined> => {
    if (disposed) return undefined
    const token = generation
    const isActive = (): boolean => active(token)
    const sessionId = options.getSessionId()
    // No session yet: the server has nothing scoped to answer with, and asking
    // anyway would return every conversation's records for the cursor to skip.
    if (sessionId === '') return undefined
    const since = options.getSince()
    let response: DeliveriesResponse
    try {
      response = await http.deliveries(sessionId, since)
    } catch (error: unknown) {
      if (!isActive()) return undefined
      lastError = error
      // A network failure never calls onCycle, so this is the ONLY place the
      // dock can learn the plugin is offline: publish on the failure path too.
      options.onSettled?.()
      return undefined
    }
    if (!isActive()) return undefined
    // A successful, well-formed poll clears any previous outage so the dock
    // banner disappears on its own (never a sticky false alarm).
    lastError = undefined
    try {
      await options.onCycle(response, sessionId, isActive)
      if (isActive()) options.onSettled?.()
    } catch (error: unknown) {
      lastError = error
      // 循环体抛错以前是静默的：卡片永远不出现、发送永远禁用，而页面上没有任何线索。
      // 这里必须留一行可读的诊断（控制台一处，dock 的可用性横幅由 onSettled 负责）。
      console.warn('[dsh-builtin-browser] delivery cycle failed:', error)
      if (isActive()) options.onSettled?.()
    }
    return response
  }

  /** Coalesce concurrent triggers onto the in-flight request. */
  const pollOnce = (): Promise<DeliveriesResponse | undefined> => {
    if (disposed) return Promise.resolve(undefined)
    if (inFlight !== undefined) return inFlight
    const task = runPoll().finally(() => {
      // A session switch may already have queued a fresh request; only clear
      // our own slot so the new one is not dropped by our late completion.
      if (inFlight === task) inFlight = undefined
    })
    inFlight = task
    return task
  }

  return {
    pollOnce,
    start() {
      if (disposed || polling) return
      polling = true
      handle = scheduler.setInterval(() => { void pollOnce() }, interval)
      void pollOnce()
    },
    stop,
    setSession(_sessionId: string) {
      // The live getSessionId/getSince callbacks already point at the new
      // session; cancelling the in-flight request prevents a cross-session
      // response from being applied to the old draft. Drop the old slot too,
      // so a wake-up for the NEW conversation is not answered by the aborted
      // request and does not have to wait a whole interval.
      generation += 1
      cancellation.reset()
      inFlight = undefined
      // While polling is active, fetch the NEW session's cards immediately
      // instead of making the user wait a whole interval (up to 1500 ms).
      if (polling && !disposed) void pollOnce()
    },
    dispose() {
      if (disposed) return
      stop()
      disposed = true
      cancellation.abort()
    },
    isPolling: () => polling,
    get disposed() { return disposed },
    get lastError() { return lastError },
    cancellation,
  }
}
