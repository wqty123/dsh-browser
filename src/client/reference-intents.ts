/** Accept reference intents only from an app-owned opaque sidebar frame. */
export function receiveGuestReference(
  event: MessageEvent,
  frames: Iterable<HTMLIFrameElement>,
  owner: (frame: HTMLIFrameElement) => string | undefined,
  submit: (intent: object, sessionId: string) => Promise<void> = captureReferenceIntent,
): void {
  if (event.origin !== 'null' || event.source === null || !event.data || event.data.type !== 'dsh-browser-ref:intent') return
  const frame = Array.from(frames).find(frame => frame.contentWindow === event.source)
  if (frame === undefined) return
  const sessionId = owner(frame)
  if (typeof sessionId === 'string' && sessionId !== '') void submit(event.data, sessionId)
}

/** Submit low-trust page intents in the authenticated app context. */
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
