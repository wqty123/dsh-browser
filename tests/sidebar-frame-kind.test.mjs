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
  const call = host.slice(host.indexOf("op: 'ensureSidebar'"))
  const block = call.slice(0, call.indexOf('this.views.set'))
  assert.match(block, /detail\.includes\('produced no page'\)/,
    'the unproducible-page failure is recognised')
  // `panel-unusable`, not a bare reportLost(): the shell is alive and answered this very request, so
  // the fallback must not tell the user their desktop shell exited. That is what it did before this
  // reason existed, and a reporter read it as their shell having crashed.
  assert.match(block, /this\.reportLost\('panel-unusable'\)/, 'and treated as an unusable PANEL, not an exited shell')
})

test('a panel that is merely not displayed is not treated as loss', () => {
  // Issue #37. The two failures used to be one string, and the plugin read both as a dead carrier:
  // switching to a self-hosted window whose page was blank, while the bridge's own message said the
  // page was fine and would attach as soon as the conversation was shown.
  const call = host.slice(host.indexOf("op: 'ensureSidebar'"))
  const block = call.slice(0, call.indexOf('this.views.set'))
  // The code decides, and it is checked BEFORE the text heuristic.
  const codeCheck = block.indexOf('code === PANEL_NOT_DISPLAYED')
  const textCheck = block.indexOf("detail.includes('produced no page')")
  assert.ok(codeCheck !== -1, 'the display state is recognised by its code')
  assert.ok(textCheck === -1 || codeCheck < textCheck, 'and it is decided before the text heuristic')
  // A display refusal is retried while the shell renders the conversation it was asked to show, and
  // the retry is bounded: an unbounded one would turn "this shell cannot render a panel" into a hang.
  assert.match(block, /for \(let attempt = 0; attempt < PANEL_DISPLAY_RETRIES && displayRefusal\(answer\); attempt \+= 1\)/,
    'the retry is bounded by a named constant, not a wall clock')
  assert.match(host, /const PANEL_DISPLAY_RETRIES = \d+/, 'and that constant exists')
  assert.match(host, /PANEL_DISPLAY_RETRY_MS \*\s*PANEL_DISPLAY_RETRIES|PANEL_DISPLAY_RETRIES[\s\S]{0,200}PANEL_DISPLAY_RETRY_MS/,
    'with a wait, so a refusal is not re-sent in a tight loop')
  // It is thrown as its own error class, which the retry classifier refuses.
  assert.match(block, /throw new BrowserPanelNotDisplayedError\(detail\)/,
    'and surfaced as a state the user can change, not as a failure')
  assert.match(host, /if \(error instanceof BrowserPanelNotDisplayedError\) return false/,
    'which the retry classifier refuses to treat as a vanished guest')
  // Nothing in that branch reports a loss.
  const branch = block.slice(codeCheck, block.indexOf("if (detail.includes('produced no page'))"))
  assert.doesNotMatch(branch, /reportLost/, 'and nothing in it reports the carrier as lost')
})
