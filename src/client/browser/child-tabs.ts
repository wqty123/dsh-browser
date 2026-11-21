import type { BrowserChildTabRequest, BrowserChildTabResult } from '../../types.ts'
import { parseBrowserAddress } from './url.ts'

export function dispatchChildTab(request: BrowserChildTabRequest, applicationOrigin: string,
  open: (url: string) => void, alive = true): BrowserChildTabResult {
  if (!alive) return { status: 'unsupported', code: 'guest-disposed' }
  if (request.mode !== 'url-only') return { status: 'unsupported', code: 'native-child-opener-unavailable' }
  if (typeof request.url !== 'string' || !/^https?:\/\//iu.test(request.url)) return { status: 'unsupported', code: 'invalid-child-url' }
  const parsed = parseBrowserAddress(request.url, applicationOrigin)
  if (!parsed.ok || !['http', 'https'].includes(parsed.target.kind)) return { status: 'unsupported', code: 'invalid-child-url' }
  try { open(parsed.target.url) }
  catch { return { status: 'unsupported', code: 'sidebar-tab-dispatch-failed' } }
  return { status: 'url-only-dispatched' }
}
