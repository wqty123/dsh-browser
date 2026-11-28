// A shell whose sidebar browser panel is an iframe, from #30.
//
// The reported symptom is that installing the bridge made the browser WORSE than not installing it:
// the carrier switched to the sidebar, the sidebar could not provide a page, and nothing returned
// the surface to the self-hosted browser that worked. Every tool here is built on CDP, and an
// iframe has no CDP endpoint — so the carrier is not merely unready, it is undrivable, and no
// amount of waiting changes that.
//
// Measured by the reporter on DSH Desktop 2.0.17: `lib/preload.cjs` exposes only `protocolVersion`
// (so the official client takes its iframe path) and the shell window sets `webviewTag: false`.
// Neither is repairable from a plugin, and both are legible from the renderer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'
import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'
import { carrierHarness } from './carrier-harness.mjs'
import { testTab } from './canonical-fixtures.mjs'

const bridge = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/browser-electron/desktop-bridge-host.ts', import.meta.url), 'utf8')

test('the liveness answer carries the panel kind, read from the same attribute the shell sets', () => {
  // The official client keys off this attribute to choose between its webview and iframe paths, so
  // reading the same thing keeps this plugin and the shell in agreement about which one it got.
  assert.match(bridge, /data-sidebar-browser-frame/, 'the frame kind is read from the shell\'s own marker')
  assert.match(bridge, /const frame = await sidebarFrameKind\(/, 'and reported on the liveness answer')
})

test('the frame kind is read without a conversation, because it is a property of the shell', () => {
  // Both conditions (`dshDesktop.browser`, `webviewTag`) are fixed when the WINDOW is created, so
  // the answer cannot differ per conversation. Passing an owner here also broke a real invariant:
  // the liveness probe must stay owner-less because it acts for nobody.
  const fn = bridge.slice(bridge.indexOf('async function sidebarFrameKind('))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.doesNotMatch(body, /owner/, 'no conversation is involved')
  assert.match(body, /executeJavaScript/, 'and the shell is read the same way every other shell read is')
  assert.match(host, /const answer = await probe\.call\(\{ op: 'list' \}, CARRIER_PROBE_TIMEOUT_MS\)/,
    'which is what the owner-less probe already sends')
})

test('an iframe panel is refused for CDP with an actionable sidebar-only error', async t => {
  const discover = DesktopBridgeViewHost.discover.bind(DesktopBridgeViewHost)
  const h = carrierHarness(t, { discover })
  writeFileSync(join(process.env.DSH_HOME, 'dsh-builtin-browser-bridge.json'), JSON.stringify({ port: 1, token: 'fixture', pid: process.pid }))
  let frame
  const probe = t.mock.method(BridgeConnection.prototype, 'call', async request => {
    assert.deepEqual(request, { op: 'list' }, 'discovery is owner-less')
    return { ok: true, protocol: 4, frame }
  })
  for (frame of ['iframe', 'webview', 'none', 'unknown', undefined]) {
    const found = await DesktopBridgeViewHost.discover('session-owner')
    assert.equal(found !== undefined, frame !== 'iframe')
    assert.equal(DesktopBridgeViewHost.refusedIframePanel(), frame === 'iframe', 'old refusal cannot taint later discovery')
    found?.dispose()
  }
  frame = 'iframe'
  await assert.rejects(h.current.createView(testTab('session-owner')).sendCommand('Runtime.evaluate'), /sidebar is an iframe.*cannot support CDP tools.*host-provided sidebar\/webview.*No standalone browser will be opened/)
  assert.equal(h.registered.length, 1)
  assert.ok(probe.mock.callCount() >= 6)
})

test('a panel requires explicit unusable evidence before carrier fallback', () => {
  // This is the half that makes the report's "worse than not installing it" true: the carrier was
  // switched to one that cannot work, and the failure repeated on every call until DSH restarted.
  // `onLost` is the mechanism that already returns the surface; it simply was not reachable from
  // this failure.
  // Anchored on the PRESENTING lookup, not on the first mention of the op: a read-only lookup (the
  // preview path, issue #46) is a separate branch above this one and must not be sliced in here.
  const call = host.slice(host.indexOf('const deadline = options?.deadline'))
  const block = call.slice(0, call.indexOf('createView('))
  assert.match(block, /code === PANEL_INITIALIZING/, 'initialization failure is recognised by code')
  // `panel-unusable`, not a bare reportLost(): the shell is alive and answered this very request, so
  // the fallback must not tell the user their desktop shell exited. That is what it did before this
  // reason existed, and a reporter read it as their shell having crashed.
  assert.match(block, /if \(code === 'panel-unusable'\) this\.lostListener\?\.\('panel-unusable'\)/, 'only explicit unusable evidence reports loss')
  assert.match(block, /code === PANEL_INITIALIZING\) throw new BrowserPanelNotDisplayedError\(detail, code\)/,
    'an initialization timeout remains recoverable')
})

test('a panel that is merely not displayed is not treated as loss', () => {
  // Issue #37. The two failures used to be one string, and the plugin read both as a dead carrier:
  // switching to a self-hosted window whose page was blank, while the bridge's own message said the
  // page was fine and would attach as soon as the conversation was shown.
  // Anchored on the PRESENTING lookup, not on the first mention of the op: a read-only lookup (the
  // preview path, issue #46) is a separate branch above this one and must not be sliced in here.
  const call = host.slice(host.indexOf('const deadline = options?.deadline'))
  const block = call.slice(0, call.indexOf('createView('))
  // The code decides, and it is checked BEFORE the text heuristic.
  const codeCheck = block.indexOf('code === PANEL_NOT_DISPLAYED')
  const textCheck = block.indexOf("detail.includes('produced no page')")
  assert.ok(codeCheck !== -1, 'the display state is recognised by its code')
  assert.ok(textCheck === -1 || codeCheck < textCheck, 'and it is decided before the text heuristic')

  assert.doesNotMatch(block, /PANEL_DISPLAY_RETRIES|displayRefusal|setTimeout/,
    'a display refusal is surfaced without a retry loop')
  // It is thrown as its own error class, which the retry classifier refuses.
  assert.match(block, /throw new BrowserPanelNotDisplayedError\(detail, code\)/,
    'and surfaced as a state the user can change, not as a failure')
  assert.doesNotMatch(host, /retryableGuest|isGoneGuest/, 'there is no guest replacement retry classifier')
  // Nothing in that branch reports a loss.
  const branch = block.slice(codeCheck, block.indexOf("if (code === 'panel-unusable')"))
  assert.doesNotMatch(branch, /reportLost/, 'and nothing in it reports the carrier as lost')
})
