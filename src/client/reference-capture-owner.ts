import { captureReferenceIntent } from './reference-intents.ts'
import { referenceOwnerKey } from '../reference-owner.ts'

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
  return async (intent, owner) => {
    signal.throwIfAborted()
    const capture = (intent as { capture?: { ok?: boolean; events?: readonly unknown[] } }).capture
    if (capture?.ok !== true || !Array.isArray(capture.events) || capture.events.length === 0) {
      throw new Error('reference intent has no captured content')
    }
    const uiSession = ctx.get('uiSession') as { adapter?: { current?: Source<{ readonly key: string | undefined }> } } | undefined
    const current = uiSession?.adapter?.current
    if (current === undefined) throw new Error('reference capture requires the host Session selection service')
    let sessionId = current.getSnapshot().key
    if (opening !== undefined || current.getSnapshot().key === undefined) {
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
          let workspace = owner === undefined ? undefined : snapshot.items.find(item =>
            item.sessionIds.some(id => referenceOwnerKey(id) === referenceOwnerKey(owner)))
          if (workspace === undefined && snapshot.items.length !== 0) {
            const sessions = ctx.get('sessions') as Sessions | undefined
            if (sessions === undefined) throw new Error('reference capture requires the host Session catalog')
            const catalog = await waitFor(sessions.list, value => value.phase === 'ready' ? value : undefined, signal)
            workspace = recentWorkspace(snapshot.items, catalog)
          }
          const target = workspace ?? await workspaces.initializeDefault(signal)
          signal.throwIfAborted()
          if (target === undefined) throw new Error('reference capture requires a current or default Workspace; select a Workspace first')
          if (current.getSnapshot().key !== undefined) throw new Error('reference Session selection was superseded')
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
  }
}
