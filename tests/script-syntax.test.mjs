// Every page-side script the provider sends is a STRING. The TypeScript compiler never sees the
// code inside one, so a syntax error there is discovered by a user whose click did nothing — and
// the resolve paths are the ones that grew a cross-root collector, which is exactly the kind of
// change that can break the string without breaking the build.
//
// The calls are aborted shortly after they start (all three accept an AbortSignal) so the
// tests do not sit in a locate loop waiting for an element that never appears; what is under
// test is the text that got sent, not the outcome.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** A host that records every expression it is asked to evaluate. */
function makeHost(scripts) {
  let counter = 0
  return {
    createView() {
      return {
        id: `view${++counter}`,
        async sendCommand(method, params) {
          if (method === 'Runtime.evaluate') {
            if (typeof params?.expression === 'string') scripts.push(params.expression)
            // Reported as "nothing found", which keeps the resolve path polling until the
            // abort signal fires. That is the point: the script has already been sent.
            return { result: { value: null } }
          }
          return {}
        },
        async download() {},
        async capture() { return { base64: '', mime: 'image/png' } },
      }
    },
    destroyView() {},
    showView() {},
    groupView() {},
    onUserAction() {},
  }
}

/** A signal that aborts almost immediately, so a locate loop cannot spin for its full budget. */
function abortSoon() {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  return controller.signal
}

test('every page-side script the provider sends compiles', async () => {
  const scripts = []
  const provider = new ElectronBrowserProvider(makeHost(scripts), {})
  const session = await provider.open()

  // Each of these reaches the resolve path that now searches every root. Failures are expected
  // (the abort, or a fixture that is not a real page); the scripts are what matter.
  //
  // `click` takes `{ target }` and NOT a bare `{ by, value }` — a bare one is read as coordinate
  // input, skips the resolve path entirely and reports missing x/y. That mistake is why this
  // test first captured two scripts instead of three.
  const attempts = [
    () => provider.click(session, { target: { by: 'css', value: '#target' } }, abortSoon()),
    () => provider.type(session, { target: { by: 'css', value: '#target' }, text: 'hi' }, abortSoon()),
    () => provider.setValue(session, { target: { by: 'css', value: '#target' }, value: 'v' }, abortSoon()),
  ]
  for (const attempt of attempts) {
    try {
      await attempt()
    } catch {
      // Expected: aborted, or the stub is not a page. The script was sent either way.
    }
  }

  assert.ok(scripts.length >= 3, `expected a script per resolve path, captured ${scripts.length}`)
  for (const script of scripts) {
    assert.doesNotThrow(
      () => new Function(script),
      `this script does not compile: ${script.slice(0, 120)}`,
    )
  }
})

test('the resolve scripts agree about searching every root', async () => {
  // A weaker but cheaper guard than executing them in a real page: whichever script decides
  // where an element can live must walk shadow roots and iframes, or the "I can see it but I
  // cannot click it" asymmetry comes back for whichever path was missed.
  const scripts = []
  const provider = new ElectronBrowserProvider(makeHost(scripts), {})
  const session = await provider.open()
  try {
    await provider.click(session, { target: { by: 'css', value: '#target' } }, abortSoon())
  } catch { /* see above */ }

  const resolveScript = scripts.find(script => script.includes('invalid CSS selector'))
  assert.ok(resolveScript !== undefined, 'the resolve script was sent')
  assert.match(resolveScript, /shadowRoot/, 'it descends into shadow roots')
  assert.match(resolveScript, /contentDocument/, 'it descends into same-origin iframes')
  // Called, not merely defined: an unused collector would satisfy a looser check while leaving
  // the resolve path on the top document.
  assert.match(resolveScript, /const roots = allRoots\(\)/, 'it USES the collector rather than the bare document')
  assert.match(resolveScript, /seen\.has\(doc\)/, 'the collector guards against revisiting a root')
})
