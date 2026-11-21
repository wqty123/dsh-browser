import { referenceOwnerKey } from '../../reference-owner.ts'
import { TAKEOVER_ROUTE, type TakeoverNotice, type TakeoverSummary } from '../../takeover-protocol.ts'

const readers = new Map<string, { owner: string; read: (signal: AbortSignal) => Promise<TakeoverSummary> }>()

export function registerTakeoverSummary(pageId: string, owner: string, read: (signal: AbortSignal) => Promise<TakeoverSummary>): () => void {
  const reader = { owner: referenceOwnerKey(owner), read }
  readers.set(pageId, reader)
  return () => { if (readers.get(pageId) === reader) readers.delete(pageId) }
}

export async function readTakeoverSummary(pageId: string, owner: string, signal: AbortSignal): Promise<TakeoverSummary> {
  const reader = readers.get(pageId)
  if (!reader || reader.owner !== referenceOwnerKey(owner)) throw new Error('takeover source is unavailable')
  return reader.read(signal)
}

export function connectBrowserTakeover(options: {
  readonly owner: string
  readonly tabId: string
  readonly pageId: string
  readonly current: () => { url: string; active: boolean; navigationUrl?: string }
  readonly changed: (notice?: TakeoverNotice, error?: boolean) => void
}, signal: AbortSignal): { answer(outcome: 'done' | 'skipped'): Promise<void> } {
  let lease: string | undefined, notice: TakeoverNotice | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let answering = false
  const post = async (body: object): Promise<{ lease?: string; notice?: TakeoverNotice }> => {
    const response = await fetch(TAKEOVER_ROUTE, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    if (!response.ok) {
      if (response.status === 400) lease = undefined
      throw new Error('browser takeover channel unavailable')
    }
    return response.json()
  }
  const poll = async (): Promise<void> => {
    try {
      if (!lease) {
        const registered = await post({ operation: 'register', owner: options.owner, tabId: options.tabId, pageId: options.pageId, ...options.current() })
        lease = registered.lease
        if (!lease) throw new Error('browser takeover lease missing')
      }
      const result = await post({ operation: 'poll', lease, ...options.current() })
      notice = result.notice
      if (!signal.aborted) options.changed(notice?.phase === 'waiting' && !answering ? notice : undefined)
      if (notice?.phase === 'summary' && options.pageId.startsWith('iframe:')) {
        const summary = await readTakeoverSummary(options.pageId, options.owner, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
        await post({ operation: 'summary', lease, id: notice.id, summary })
      }
    } catch {
      if (!signal.aborted) options.changed(undefined)
    }
    if (!signal.aborted) timer = setTimeout(() => { void poll() }, 400)
  }
  const stop = (): void => {
    clearTimeout(timer)
    options.changed(undefined)
    if (lease) void fetch(TAKEOVER_ROUTE, { method: 'POST', credentials: 'include', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'remove', lease }) }).catch(() => {})
  }
  signal.addEventListener('abort', stop, { once: true })
  if (!signal.aborted) void poll()
  return { async answer(outcome) {
    if (!notice || notice.phase !== 'waiting' || answering || signal.aborted) return
    answering = true
    const current = notice
    options.changed(undefined)
    try { await post({ operation: 'answer', lease, id: current.id, outcome }) }
    catch { if (!signal.aborted) options.changed(current, true) }
    finally { answering = false }
  } }
}
