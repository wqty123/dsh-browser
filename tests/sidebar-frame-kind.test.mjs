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
import { readFileSync } from 'node:fs'

const bridge = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/browser-electron/desktop-bridge-host.ts', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/browser-electron/entry.ts', import.meta.url), 'utf8')

test('the liveness answer carries the panel kind, read from the same attribute the shell sets', () => {
  // The official client keys off this attribute to choose between its webview and iframe paths, so
  // reading the same thing keeps this plugin and the shell in agreement about which one it got.
  assert.match(bridge, /data-sidebar-browser-frame/, 'the frame kind is read from the shell\'s own marker')
  assert.match(bridge, /frame: await sidebarFrameKind\(/, 'and reported on the liveness answer')
})

test('the frame kind is read without a conversation, because it is a property of the shell', () => {
  // Both conditions (`dshDesktop.browser`, `webviewTag`) are fixed when the WINDOW is created, so
  // the answer cannot differ per conversation. Passing an owner here also broke a real invariant:
  // the liveness probe must stay owner-less because it acts for nobody.
  const fn = bridge.slice(bridge.indexOf('async function sidebarFrameKind('))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.doesNotMatch(body, /owner/, 'no conversation is involved')
  assert.match(body, /executeJavaScript/, 'and the shell is read the same way every other shell read is')
  assert.match(host, /const answer = await probe\.call\(\{ op: 'list' \}, 5_000\)/,
    'which is what the owner-less probe already sends')
})

test('an iframe panel is refused, and the other answers are not', () => {
  // Refusing on `none` would break the first open of every session (the panel does not exist until
  // it is asked for), and refusing on `unknown` would break a carrier because a probe ran early.
  assert.match(host, /if \(String\(answer\.frame \?\? 'unknown'\) === 'iframe'\) \{/,
    'only iframe is a refusal')
  assert.match(host, /DesktopBridgeViewHost\.refuseIframe = true/, 'and it is recorded')
  assert.match(host, /static refusedIframePanel\(\): boolean/, 'so the entry point can say why')
  assert.match(entry, /a desktop bridge is installed, but this shell renders the sidebar/,
    'and it does')
})

test('a panel that produces no page returns the surface to the self-hosted browser', () => {
  // This is the half that makes the report's "worse than not installing it" true: the carrier was
  // switched to one that cannot work, and the failure repeated on every call until DSH restarted.
  // `onLost` is the mechanism that already returns the surface; it simply was not reachable from
  // this failure.
  const call = host.slice(host.indexOf('const answer = await this.connection.call({\n      op: \'ensureSidebar\''))
  const block = call.slice(0, call.indexOf('this.views.set'))
  assert.match(block, /String\(answer\.error\)\.includes\('produced no page'\)/,
    'the unproducible-page failure is recognised')
  assert.match(block, /this\.reportLost\(\)/, 'and treated as carrier loss')
})
