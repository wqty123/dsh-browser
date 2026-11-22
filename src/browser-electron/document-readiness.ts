import { BrowserError } from '../browser/types.ts'
import type { ElectronViewHandle } from './provider.ts'

export interface DocumentIdentity {
  readonly id: string
  readonly loaderId: string
  readonly url: string
  readonly unreachableUrl?: string
}

export function mainDocument(value: unknown, options?: { readonly allowErrorDocument?: boolean }): DocumentIdentity {
  const frame = (value as { frameTree?: { frame?: DocumentIdentity } } | undefined)?.frameTree?.frame
  if (typeof frame?.id !== 'string' || frame.id === ''
    || typeof frame.loaderId !== 'string' || frame.loaderId === '' || typeof frame.url !== 'string') {
    throw new BrowserError('browser: the guest did not acknowledge its main document identity', 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
  }
  if (frame.unreachableUrl && options?.allowErrorDocument !== true) {
    throw new BrowserError(`browser: failed to load ${frame.unreachableUrl}`, 'BROWSER_NAVIGATION_FAILED')
  }
  return frame
}

/** Check parse readiness in an isolated world bound to the acknowledged main frame. */
export async function documentReady(handle: ElectronViewHandle, expected: DocumentIdentity, checkCurrent = (): void => {}): Promise<boolean> {
  checkCurrent()
  const world = await handle.sendCommand('Page.createIsolatedWorld', { frameId: expected.id, worldName: 'dsh-browser-readiness' }, { present: false, initialize: false }) as { executionContextId?: number }
  checkCurrent()
  if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId! <= 0) {
    throw new BrowserError('browser: the guest did not acknowledge a document execution context', 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
  }
  const result = await handle.sendCommand('Runtime.evaluate', {
    expression: 'document.readyState', contextId: world.executionContextId, returnByValue: true,
  }, { present: false, initialize: false }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  checkCurrent()
  const after = mainDocument(await handle.sendCommand('Page.getFrameTree', undefined, { present: false, initialize: false }))
  checkCurrent()
  if (after.id !== expected.id || after.loaderId !== expected.loaderId) {
    throw new BrowserError('browser: the acknowledged document was superseded', 'BROWSER_NAVIGATION_SUPERSEDED')
  }
  if (result.exceptionDetails !== undefined || !['loading', 'interactive', 'complete'].includes(String(result.result?.value))) {
    throw new BrowserError('browser: the document did not acknowledge its parse state', 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
  }
  return result.result?.value !== 'loading'
}
