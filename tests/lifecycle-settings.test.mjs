// Lifecycle settings (requirements §3).
//
// Two behaviours are user choices, not fixed rules:
//   - `ui.closeWithSession`: releasing the browser when its session ends;
//   - `ui.autoExpandOnce`: whether the agent's page takes over the screen.
// Both only mean anything on a carrier that outlives a session — the desktop
// sidebar — which is why they are expressed through the optional host hooks
// `releasePage` / `collapse` rather than assumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** Host stub that records the lifecycle hooks it is asked for. */
function makeHost() {
  const calls = { releasePage: 0, collapse: 0, showView: 0, destroyView: 0 }
  return {
    calls,
    createView() {
      return {
        id: 'view1',
        async sendCommand(method, params) {
          if (method === 'Runtime.evaluate') {
            const expression = params.expression ?? ''
            if (expression.includes('timeOrigin')) return { result: { value: '1|complete' } }
            if (expression.includes('document.title')) return { result: { value: 'https://example.com/\u0000Example' } }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    destroyView() { calls.destroyView += 1 },
    showView() { calls.showView += 1 },
    groupView() {},
    onUserAction() {},
    async releasePage() { calls.releasePage += 1 },
    async collapse() { calls.collapse += 1 },
  }
}

const withUi = (ui, host = makeHost()) => ({
  p: new ElectronBrowserProvider(host, { settings: () => ({ ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, ...ui } }) }),
  host,
})

test('off by default: ending a session leaves the carrier running', async () => {
  const { p, host } = withUi({})
  const sid = await p.open()
  await p.close(sid)
  assert.equal(host.calls.releasePage, 0, 'the default never asks the shell to release anything')
  // destroyView still runs: our own view handles are always torn down.
  assert.ok(host.calls.destroyView > 0, 'our view handles are released regardless')
})

test('closeWithSession releases the page when the session ends', async () => {
  const { p, host } = withUi({ closeWithSession: true })
  const sid = await p.open()
  await p.close(sid)
  // The hook is fire-and-forget from close(), so let its microtask run.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(host.calls.releasePage, 1, 'the shell was asked to release the page')
})

test('a carrier without the hook is unaffected', async () => {
  // Self-hosted carriers tear the window down with the views and implement neither
  // hook; asking must simply not happen.
  const host = makeHost()
  delete host.releasePage
  delete host.collapse
  const p = new ElectronBrowserProvider(host, {
    settings: () => ({ ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, closeWithSession: true, autoExpandOnce: false } }),
  })
  const sid = await p.open()
  await p.close(sid)
  assert.ok(host.calls.destroyView > 0, 'views are still released')
})

test('explicit navigation remains presented when automatic sidebar expansion is disabled', async () => {
  const { p, host } = withUi({ autoExpandOnce: false, quiet: false })
  const sid = await p.open()
  host.calls.collapse = 0
  await p.openUrl(sid, { url: 'https://example.com' })
  assert.equal(host.calls.collapse, 0, 'an explicit open must leave its target sidebar expanded')
  await p.close(sid)
})

// The autoExpandOnce half of §3 is asserted in desktop-bridge-host.test.mjs, at
// the layer that actually owns folding the sidebar: the provider's part is only
// "call the hook, or do not", and every trigger for it runs through private paths
// that a test would have to fake wholesale.
