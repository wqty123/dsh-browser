import { captureReferenceIntent } from './reference-intents.ts'

interface Source<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface Workspace {
  readonly workspaceId: string
  readonly createdAt: string
  readonly sessionIds: readonly string[]
}

interface Workspaces {
  readonly list: Source<{ readonly phase: string; readonly state: string; readonly items: readonly Workspace[] }>
  initializeDefault(signal?: AbortSignal): Promise<Workspace | undefined>
}

interface WorkspaceNavigation {
  openWorkspace(id: string, beforeOpen: (sessionId: string) => void): Promise<void>
}

interface Sessions {
  readonly list: Source<{ readonly phase: string; readonly byId: Readonly<Record<string, { readonly updatedAt: number }>> }>
}

function recentWorkspace(items: readonly Workspace[], sessions: ReturnType<Sessions['list']['getSnapshot']>): Workspace | undefined {
  let selected: Workspace | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of items) {
    let latest = Number.NEGATIVE_INFINITY
    for (const id of workspace.sessionIds) {
      const session = sessions.byId[id]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace
      selectedTime = latest
    }
  }
  return selected
}

export interface ReferenceCaptureContext {
  get(name: string): unknown
}

const CAPTURE_TIMEOUT_MS = 30_000

function captureTransaction(signal: AbortSignal, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const timeout = new AbortController()
  const transaction = AbortSignal.any([signal, timeout.signal])
  let abort = (): void => {}
  const timer = setTimeout(() => {
    timeout.abort(new Error('reference capture was not acknowledged within 30 seconds; please retry'))
  }, CAPTURE_TIMEOUT_MS)
  return new Promise<void>((resolve, reject) => {
    abort = () => { reject(transaction.reason) }
    transaction.addEventListener('abort', abort, { once: true })
    if (transaction.aborted) { abort(); return }
    run(transaction).then(resolve, reject)
  }).finally(() => {
    clearTimeout(timer)
    transaction.removeEventListener('abort', abort)
  })
}

function sessionKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function waitFor<T, R>(source: Source<T>, read: (value: T) => R | undefined, signal: AbortSignal): Promise<R> {
  return new Promise((resolve, reject) => {
    let stop = (): void => {}
    let settled = false
    const finish = (error?: unknown, value?: R): void => {
      if (settled) return
      settled = true
      stop()
      signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(value as R)
    }
    const abort = (): void => { finish(signal.reason) }
    const check = (): void => {
      try {
        signal.throwIfAborted()
        const value = read(source.getSnapshot())
        if (value !== undefined) finish(undefined, value)
      } catch (error) { finish(error) }
    }
    stop = source.subscribe(check)
    if (settled) { stop(); return }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

/** Resolve quote ownership from the host selection, creating a Session through Workspace navigation when absent. */
export function createReferenceCapture(ctx: ReferenceCaptureContext, signal: AbortSignal):
  (intent: object, owner?: string) => Promise<void> {
  let opening: Promise<string> | undefined
  return (intent, owner) => captureTransaction(signal, async signal => {
    signal.throwIfAborted()
    const capture = (intent as { capture?: { ok?: boolean; events?: readonly unknown[] } }).capture
    if (capture?.ok !== true || !Array.isArray(capture.events) || capture.events.length === 0) {
      throw new Error('reference intent has no captured content')
    }
    const uiSession = ctx.get('uiSession') as { adapter?: { current?: Source<{ readonly key: string | undefined }> } } | undefined
    const current = uiSession?.adapter?.current
    const selected = sessionKey(current?.getSnapshot().key) ?? sessionKey(owner)
    if (selected !== undefined) {
      await captureReferenceIntent(intent, selected, signal)
      return
    }
    if (current === undefined) throw new Error('reference capture requires the host Session selection service')
    let sessionId = sessionKey(current.getSnapshot().key)
    if (opening !== undefined || sessionId === undefined) {
      if (opening === undefined) {
        const open = async (): Promise<string> => {
          const workspaces = ctx.get('workspaces') as Workspaces | undefined
          const navigation = ctx.get('uiWorkspace') as WorkspaceNavigation | undefined
          if (workspaces === undefined || navigation?.openWorkspace === undefined) {
            throw new Error('reference capture requires the host Workspace navigation service')
          }
          const snapshot = await waitFor(workspaces.list, value => {
            if (value.state === 'error') throw new Error('reference capture could not load Workspaces')
            return value.phase === 'ready' ? value : undefined
          }, signal)
          let workspace: Workspace | undefined
          if (snapshot.items.length !== 0) {
            const sessions = ctx.get('sessions') as Sessions | undefined
            if (sessions === undefined) throw new Error('reference capture requires the host Session catalog')
            const catalog = await waitFor(sessions.list, value => value.phase === 'ready' ? value : undefined, signal)
            workspace = recentWorkspace(snapshot.items, catalog)
          }
          const target = workspace ?? await workspaces.initializeDefault(signal)
          signal.throwIfAborted()
          if (target === undefined) throw new Error('reference capture requires a current or default Workspace; select a Workspace first')
          if (sessionKey(current.getSnapshot().key) !== undefined) throw new Error('reference Session selection was superseded')
          let resolved: string | undefined
          await navigation.openWorkspace(target.workspaceId, id => {
            signal.throwIfAborted()
            resolved = id
          })
          signal.throwIfAborted()
          if (resolved === undefined || resolved.trim() === '') throw new Error('reference Session selection was not acknowledged')
          const expected = resolved
          return waitFor(current, value => {
            if (value.key !== undefined && value.key !== expected) throw new Error('reference Session selection was superseded')
            return value.key === expected ? expected : undefined
          }, signal)
        }
        opening = open().finally(() => { opening = undefined })
      }
      sessionId = await opening
    }
    if (current.getSnapshot().key !== sessionId) throw new Error('reference Session selection was superseded')
    await captureReferenceIntent(intent, sessionId ?? '', signal)
  })
}
