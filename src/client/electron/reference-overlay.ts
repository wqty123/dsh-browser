import { overlayScript, standaloneScript } from '../../browser-reference/entry.ts'

const takeIntents = `JSON.stringify((function () {
  var intents = []
  if (typeof window.__dshRefTake !== 'function') return intents
  for (var i = 0; i < 100; i++) {
    var intent = window.__dshRefTake()
    if (!intent || typeof intent !== 'object') break
    intents.push(intent)
  }
  return intents
})())`

/** One document's overlay and serialized polling loop; navigation errors are expected. */
export function installReferenceOverlay(execute: (source: string) => Promise<unknown>,
  consume: (intent: object) => void, signal: AbortSignal): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  const poll = async (): Promise<void> => {
    if (signal.aborted) return
    try {
      const result = await execute(takeIntents)
      if (signal.aborted) return
      const intents: unknown = typeof result === 'string' ? JSON.parse(result) : undefined
      if (Array.isArray(intents)) {
        for (const intent of intents) {
          if (intent !== null && typeof intent === 'object') consume(intent)
        }
      }
    } catch { /* A document may disappear during executeJavaScript. */ }
    if (!signal.aborted) timer = setTimeout(() => { void poll() }, 300)
  }
  void (async () => {
    if (signal.aborted) return
    try { await execute(standaloneScript(overlayScript(), { label: '引用到 DSH' })) }
    catch { /* Navigation can invalidate the installer. */ }
    await poll()
  })()
}
