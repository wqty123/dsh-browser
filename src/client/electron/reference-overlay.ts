import { overlayScript, standaloneScript } from '../../browser-reference/entry.ts'
import { noticeScript } from '../../browser-reference/page-script.ts'
import { reportReferenceCaptureFailure } from '../reference-intents.ts'

const takeIntents = `JSON.stringify((function () {
  var intents = []
  if (typeof window.__dshRefTake !== 'function') return intents
  for (var i = 0; i < 100; i++) {
    var intent = window.__dshRefTake()
    if (intent == null) break
    intents.push(intent)
  }
  return intents
})())`

/** One document's overlay and serialized polling loop; navigation errors are expected. */
export function installReferenceOverlay(execute: (source: string) => Promise<unknown>,
  consume: (intent: object) => void | Promise<void>, signal: AbortSignal): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  const poll = async (): Promise<void> => {
    if (signal.aborted) return
    try {
      const result = await execute(takeIntents)
      let intents: unknown[] = []
      try {
        const decoded: unknown = typeof result === 'string' ? JSON.parse(result) : undefined
        if (!Array.isArray(decoded)) throw new Error('reference intent drain was not acknowledged')
        intents = decoded
      } catch (error) { reportReferenceCaptureFailure(error) }
      for (const intent of intents) {
        try {
          if (intent === null || typeof intent !== 'object') throw new Error('reference intent is invalid')
          await consume(intent)
        } catch (error) {
          reportReferenceCaptureFailure(error)
          if (!signal.aborted) {
            try { await execute(standaloneScript(noticeScript('引用未能加入当前会话，请重试。'))) }
            catch { /* The app notice survives navigation of the guest. */ }
          }
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
