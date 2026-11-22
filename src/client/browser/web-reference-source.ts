import { WEB_SOURCE_ROUTE, type WebRevealStatus } from '../../reference-source.ts'
import { referenceOwnerKey } from '../../reference-owner.ts'
import type { FrozenSnapshot } from '../reference/client/production/protocol.ts'
import { iframeReferenceSource } from './iframe-reference.ts'

class WebSourceHttpError extends Error {
  constructor(readonly status: number) { super(`web source channel failed (${status})`) }
}

/** The authenticated app, not the opaque guest, owns this lease and its replies. */
export async function connectWebReferenceSource(owner: string, pageId: string, currentUrl: () => string, signal: AbortSignal): Promise<void> {
  owner = referenceOwnerKey(owner)
  const post = async (body: object): Promise<{ lease?: string; commands?: readonly { id: string; reference: FrozenSnapshot; partId?: string }[] }> => {
    const response = await fetch(WEB_SOURCE_ROUTE, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    if (!response.ok) throw new WebSourceHttpError(response.status)
    return response.json()
  }
  let { lease } = await post({ operation: 'register', sessionId: owner, pageId, url: currentUrl() })
  if (!lease) throw new Error('web source lease missing')
  let timer: ReturnType<typeof setTimeout> | undefined
  let acknowledgements: { id: string; status: WebRevealStatus }[] = []
  const poll = async (): Promise<void> => {
    try {
      if (lease === undefined) {
        const registered = await post({ operation: 'register', sessionId: owner, pageId, url: currentUrl() })
        lease = registered.lease
        if (!lease) throw new Error('web source lease missing')
      }
      const response = await post({ operation: 'poll', lease, url: currentUrl(), acknowledgements })
      acknowledgements = []
      for (const command of response.commands ?? []) {
        let status: WebRevealStatus = 'unavailable'
        try {
          const source = iframeReferenceSource(pageId, owner)
          const result = await source?.reveal?.(command.reference, command.partId, AbortSignal.any([signal, AbortSignal.timeout(6_000)]))
          if (result === 'revealed' || result === 'ambiguous' || result === 'missing' || result === 'not-found' || result === 'page-mismatch' || result === 'partial') status = result
        } catch { /* A changed document cannot acknowledge a successful reveal. */ }
        acknowledgements.push({ id: command.id, status })
      }
    } catch (error) {
      if (error instanceof WebSourceHttpError && error.status === 410) { lease = undefined; acknowledgements = [] }
    }
    if (!signal.aborted) timer = setTimeout(() => { void poll() }, acknowledgements.length > 0 ? 0 : 500)
  }
  const stop = (): void => {
    clearTimeout(timer)
    void fetch(WEB_SOURCE_ROUTE, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'remove', lease }) }).catch(() => {})
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  else void poll()
}
