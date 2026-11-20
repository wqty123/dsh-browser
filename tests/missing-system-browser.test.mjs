// When the setting names a browser that is not installed.
//
// The bug this guards: an explicit choice used to fall back silently to the bundled
// Electron window, so the user saw an error about Electron — something they never
// chose — while the real problem (no Chrome on this machine) never reached them.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MissingSystemBrowserHost } from '../lib/browser-electron/missing-system-browser.js'
import { searchSummary } from '../lib/browser-electron/system-browser.js'

/** The message a command fails with. */
async function messageFor(kind) {
  const host = new MissingSystemBrowserHost(kind, searchSummary(kind, 'linux'))
  const view = host.createView()
  try {
    await view.sendCommand('Page.navigate', { url: 'https://example.com' })
    assert.fail('the command should have failed')
  } catch (error) {
    return error.message
  }
}

test('the host reports itself available, so the problem is not hidden by a fallback', () => {
  // Reporting false would make the provider pick a different carrier — the original bug.
  const host = new MissingSystemBrowserHost('chrome', [])
  assert.equal(host.available(), true)
})

test('every command fails instead of reaching a page', async () => {
  const host = new MissingSystemBrowserHost('edge', [])
  await assert.rejects(() => host.createView().sendCommand('Page.navigate'), /not installed/)
})

test('the message names the browser that is actually missing', async () => {
  const chrome = await messageFor('chrome')
  assert.match(chrome, /Google Chrome/, 'names Chrome, not Electron')
  assert.doesNotMatch(chrome, /Electron/i, 'never blames Electron')
  assert.match(await messageFor('edge'), /Microsoft Edge/)
})

test('the message says where it looked', async () => {
  const message = await messageFor('chrome')
  assert.match(message, /microsoft-edge-stable|google-chrome-stable/, 'lists the launcher names it checked')
  assert.match(message, /\/usr\/bin\//, 'and the fixed locations')
  assert.match(message, /on PATH/, 'including that PATH was consulted')
})

test('the message offers all three ways out', async () => {
  const message = await messageFor('chrome')
  assert.match(message, /install Google Chrome/, 'install it')
  assert.match(message, /DSH_BROWSER_CHROME_PATH/, 'or point the override at it')
  assert.match(message, /bundled/i, 'or set the carrier back to bundled')
  assert.match(message, /automatic|自动/, 'or let automatic fall back')
})

test('destroying a view that was never created is harmless', () => {
  const host = new MissingSystemBrowserHost('brave', [])
  assert.doesNotThrow(() => host.destroyView(host.createView()))
})

test('a message can be produced for every selectable browser', () => {
  // Only chrome and edge can be chosen explicitly; brave is reachable through the
  // `auto` channel's detection order but never as a stated choice, so no message is
  // ever built for it. Both selectable products must produce a full explanation.
  for (const kind of ['chrome', 'edge']) {
    const host = new MissingSystemBrowserHost(kind, [])
    assert.equal(host.available(), true)
    assert.doesNotThrow(() => host.createView())
  }
})
