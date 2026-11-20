/** Submit low-trust page intents in the authenticated app context. */
import { referenceOwnerKey } from '../reference-owner.ts'

export async function captureReferenceIntent(intent: object, sessionId: string): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('reference owner is unavailable')
  const response = await fetch('/dsh-builtin-browser/reference/capture', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...intent, sessionId: referenceOwnerKey(sessionId) }),
  })
  if (!response.ok) throw new Error(`reference capture failed (${response.status})`)
  const result = await response.json() as { readonly ok?: boolean }
  if (result.ok !== true) throw new Error('reference capture was not accepted')
}
