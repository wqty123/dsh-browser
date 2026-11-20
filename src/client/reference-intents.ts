/** Submit low-trust page intents from either sidebar carrier in the app context. */
export async function captureReferenceIntent(intent: object, sessionId: string): Promise<void> {
  if (sessionId === '') return
  try {
    await fetch('/dsh-builtin-browser/reference/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...intent, sessionId }),
    })
  } catch { /* The reader can retry from the bar. */ }
}
