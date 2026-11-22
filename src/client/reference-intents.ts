import { hostMessages } from '../../assets/browser-messages.mjs'
import { REFERENCE_CAPTURE_ROUTE } from '../../assets/browser-policy.mjs'
/** Submit low-trust page intents in the authenticated app context. */
import { referenceOwnerKey } from '../reference-owner.ts'

export function reportReferenceCaptureFailure(error: unknown): void {
  console.warn('[dsh-browser] reference capture failed', error)
  if (typeof document === 'undefined' || document.body === null) return
  document.getElementById('dsh-browser-reference-error')?.remove()
  const notice = document.createElement('div')
  notice.id = 'dsh-browser-reference-error'
  notice.setAttribute('role', 'alert')
  notice.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;max-width:420px;padding:12px;border-radius:8px;background:Canvas;color:CanvasText;border:1px solid GrayText;font:14px system-ui'
  const message = document.createElement('span')
  message.textContent = `${hostMessages.zh.referenceFailed}${error instanceof Error ? ` ${error.message.slice(0, 200)}` : ''}`
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = hostMessages.zh.dismiss
  dismiss.addEventListener('click', () => { notice.remove() }, { once: true })
  notice.append(message, dismiss)
  document.body.append(notice)
}

export async function captureReferenceIntent(intent: object, sessionId: string, signal?: AbortSignal): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('reference owner is unavailable')
  const response = await fetch(REFERENCE_CAPTURE_ROUTE, {
    signal,
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...intent, sessionId: referenceOwnerKey(sessionId) }),
  })
  if (!response.ok) throw new Error(`reference capture failed (${response.status})`)
  const result = await response.json() as { readonly ok?: boolean }
  if (result.ok !== true) throw new Error('reference capture was not accepted')
}
