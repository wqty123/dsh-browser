/**
 * Transport for the desktop shell's browser bridge: one long-lived connection to a
 * loopback TCP service.
 *
 * WHY THIS IS ITS OWN MODULE
 * The bridge used to be reached with a fresh connection per request, which measured
 * at ~25ms per call (TCP handshake + token exchange) against ~0.2ms when the socket
 * is reused. A single browser action issues several CDP commands, so that cost was
 * multiplied on every tool call — the difference between a snappy agent and a
 * visibly sluggish one. Reuse is therefore a property of the transport, and keeping
 * it here means the view host above does not have to think about sockets at all.
 *
 * PROTOCOL
 * The first line on a connection carries the token; the service marks the socket
 * authenticated and ignores that line as a command. Requests and answers are then
 * newline-delimited JSON, one answer per request, in order.
 *
 * @module dsh-browser/browser-electron/bridge-connection
 */

import { connect, type Socket } from 'node:net'

/** Where the shell publishes its bridge endpoint. */
export interface BridgeEndpoint {
  readonly port: number
  readonly token: string
  readonly pid: number
  readonly updatedAt?: string
}

/** One queued request, waiting for its answer. */
interface PendingCall {
  readonly resolve: (answer: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

/**
 * Safety cap on one un-answered reply line. CDP answers from the sidebar (a screenshot's
 * base64 is the big one) cross this socket, so the cap is generous; what it exists for is a
 * peer that never sends a newline — `this.buffer += chunk` grew without bound, unlike the
 * same buffer in remote-host.ts, which caps at 512 MiB.
 */
const MAX_BUFFER_BYTES = 128 * 1024 * 1024

/**
 * Field this client adds to every request so the shell can echo it back and never relies on
 * byte order to pair an answer with its request. Loosely named, and additive on purpose: a
 * bridge that does not know it simply ignores it (the current shipped shell does), and the
 * client then falls back to arrival order, which is what the protocol guaranteed before.
 */
const REQUEST_ID_FIELD = 'bridgeRequestId'

/**
 * A reusable connection to the bridge.
 *
 * Requests may be in flight CONCURRENTLY, so answers are correlated by id rather than by
 * position: `call()` stamps a unique {@link REQUEST_ID_FIELD} on the request and
 * `onData()` resolves the entry that carries the echoed id. A bridge that does not echo it
 * is still supported — the answer is then handed to the oldest outstanding request, which
 * is the arrival-order rule the protocol states — but a missing id is recorded, and once
 * that happens a later unmatched answer resets the socket rather than being handed to
 * whichever request happens to be first (which is how two concurrent calls could each
 * receive the other's answer).
 *
 * A broken socket is discarded so the next call dials again — a dead connection must never
 * become a dead plugin.
 */
export class BridgeConnection {
  private socket: Socket | undefined
  private buffer = ''
  /** Outstanding requests by id. */
  private readonly pending = new Map<number, PendingCall>()
  /** Ids of the requests sent on the current socket, oldest first. */
  private readonly queue: number[] = []
  private nextId = 1
  /** True once any reply arrived without an id: this bridge does not echo request ids. */
  private idLessBridge = false
  /** True once this connection may only have one request in flight at a time. */
  private serialisable = false

  /**
   * @param endpoint - the shell's published bridge endpoint.
   */
  constructor(private readonly endpoint: BridgeEndpoint) {}

  /**
   * Send one request, reusing the socket if it is still healthy.
   *
   * Requests may overlap: the request is written as soon as it is queued, so two concurrent
   * callers have two requests in flight. Each carries a unique {@link REQUEST_ID_FIELD}, and
   * `onData()` resolves the entry that carries the echoed id — which is what makes
   * correlation independent of arrival order. A bridge that does not echo the field (the
   * shipped shell today) still works by arrival order; see {@link onData}.
   * @param request - the request body (the token and the request id are added here).
   * @param timeoutMs - how long to wait for the answer before dropping the socket.
   * @returns the bridge's answer.
   */
  async call(request: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    // At most one retry, and only for the case it exists for: a socket whose state makes an
    // answer unattributable is dropped and redialled once. Unbounded retrying here is a
    // livelock — an earlier revision recursively re-entered `call()` whenever the socket
    // looked dirty, and while the condition could not clear itself it spun until the process
    // ran out of heap.
    for (let attempt = 0; ; attempt++) {
      const socket = this.ensureSocket()
      // A connection that has already carried an id-less answer cannot have a second
      // request in flight: two outstanding requests would be matched by position, which is
      // exactly the swap this correlation exists to prevent.
      if (this.serialisable && this.queue.length > 0 && attempt === 0) {
        this.reset(new Error('dsh-builtin-browser: bridge connection reopened so replies stay attributable'))
        continue
      }
      const id = this.nextId++
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, {
          resolve: answer => { clearTimeout(timer); resolve(answer) },
          reject: error => { clearTimeout(timer); reject(error) },
        })
        this.queue.push(id)
        const timer = setTimeout(() => {
          // Only the entry that actually timed out is forgotten. This used to search with
          // `entry.resolve === resolve`, comparing a wrapper against the original promise
          // resolver — always -1, so the splice never removed anything and the entry stayed
          // queued to be handed some LATER request's answer.
          this.forget(id)
          const error = new Error(`dsh-builtin-browser: bridge timed out after ${timeoutMs}ms`)
          // An unanswered request desynchronises the stream for an id-less bridge, and
          // leaves one outstanding for one that echoes ids — either way the next call starts
          // on a fresh socket. reset() rejects every pending entry through its wrapper, so
          // the explicit reject below is a no-op fallback that guarantees this caller settles.
          this.reset(error)
          reject(error)
        }, timeoutMs)
        try {
          // The id is added LAST so a request body can never shadow it, and the token is
          // added here rather than by the caller.
          socket.write(JSON.stringify({ token: this.endpoint.token, ...request, [REQUEST_ID_FIELD]: id }) + '\n')
        } catch (error) {
          clearTimeout(timer)
          this.forget(id)
          const failure = error instanceof Error ? error : new Error(String(error))
          this.reset(failure)
          reject(failure)
        }
      })
    }
  }

  /** Close the socket and fail anything still waiting on it. */
  close(): void {
    this.reset(new Error('dsh-builtin-browser: bridge closed'))
  }

  /** The live socket, connecting and authenticating it on first use. */
  private ensureSocket(): Socket {
    if (this.socket !== undefined) return this.socket
    const socket = connect({ host: '127.0.0.1', port: this.endpoint.port })
    socket.setEncoding('utf8')
    socket.on('data', chunk => this.onData(String(chunk)))
    socket.on('error', error => this.reset(error))
    socket.on('close', () => this.reset(new Error('dsh-builtin-browser: bridge connection closed')))
    this.buffer = ''
    this.socket = socket
    socket.write(JSON.stringify({ token: this.endpoint.token }) + '\n')
    return socket
  }

  /** Resolve queued requests by id, or in order when the bridge does not echo one. */
  private onData(chunk: string): void {
    this.buffer += chunk
    // A peer that never sends a newline must not grow this buffer without bound. Failing
    // the connection is the honest outcome: the caller gets an error naming the cap, while
    // the next call dials a fresh socket.
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = ''
      this.reset(new Error(`dsh-builtin-browser: bridge reply exceeded ${String(MAX_BUFFER_BYTES)} bytes`))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line === '') continue
      const echoed = echoOf(line)
      const id = echoed ?? this.queue[0]
      if (id === undefined) {
        // Nothing is waiting for this answer: the peer is answering something this socket
        // never asked (or answered twice). Drop the socket rather than trust the stream.
        this.reset(new Error('dsh-builtin-browser: bridge answered with no request outstanding'))
        return
      }
      const index = this.queue.indexOf(id)
      if (index !== -1) this.queue.splice(index, 1)
      const entry = this.pending.get(id)
      if (entry === undefined) continue
      this.pending.delete(id)
      // Id-less bridges pair by order, so a reply for the WRONG request cannot be told apart
      // from the right one. Remember that this bridge does not echo ids, and serialise every
      // later call so the ambiguity cannot arise again.
      if (echoed === undefined) {
        this.idLessBridge = true
        this.serialisable = true
      }
      try {
        const answer = JSON.parse(line) as Record<string, unknown>
        // A rejected token means the shell restarted with a new one, so this socket
        // can never succeed again: answer (the caller needs the error) and drop it,
        // so the next call dials afresh instead of retrying a doomed credential.
        if (answer.ok === false && answer.error === 'bad token') {
          entry.resolve(answer)
          this.reset(new Error('dsh-builtin-browser: the bridge rejected our token'))
          continue
        }
        entry.resolve(answer)
      } catch (error) {
        entry.reject(new Error(`dsh-builtin-browser: malformed bridge answer (${String(error)})`))
      }
    }
  }

  /** Forget one request (its answer can no longer be matched). */
  private forget(id: number): void {
    this.pending.delete(id)
    const index = this.queue.indexOf(id)
    if (index !== -1) this.queue.splice(index, 1)
  }

  /** Tear the socket down, failing pending work. */
  private reset(error: Error): void {
    if (this.socket !== undefined) {
      const socket = this.socket
      this.socket = undefined
      socket.removeAllListeners()
      socket.destroy()
    }
    this.buffer = ''
    this.queue.length = 0
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

/** The request id a raw answer line echoes back, when it carries one. */
function echoOf(line: string): number | undefined {
  try {
    const answer = JSON.parse(line) as Record<string, unknown>
    const value = answer[REQUEST_ID_FIELD]
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
  } catch {
    // A malformed line cannot be matched by id; the caller consumes it in order and
    // reports the parse failure itself.
    return undefined
  }
}
