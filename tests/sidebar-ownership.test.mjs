// The guard that keeps the host out of somebody else's sidebar.
//
// Measured on the running desktop: two `[class*=_tabStrip]` containers sat in the DOM at once,
// each carrying its own session id on the React fiber, and the shell only operates the visible
// one. Without a check, an operation issued while the human was reading another conversation typed
// into THAT conversation's address bar and navigated its page — the reported bug.
//
// It lives in the HOST, not the bridge, and that placement is the point: the bridge is imported
// once at host boot, so a change there costs the user a restart, while this file is read per
// process start. The probe travels over the bridge's existing `cdp` op (which executes in the
// shared main process), so the bridge needs no new capability and no edit.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const HOST_SRC = readFileSync('src/browser-electron/desktop-bridge-host.ts', 'utf8')
const HOST_BUILT = readFileSync('lib/browser-electron/desktop-bridge-host.js', 'utf8')
const BRIDGE = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')

test('the host reads the sidebar container identity from the shell', () => {
  assert.match(HOST_SRC, /__reactFiber/, 'the session id lives on the React fiber of each container')
  assert.match(HOST_SRC, /sessionOf/, 'and a helper walks it')
  assert.match(HOST_SRC, /_tabStrip/, 'looking at the sidebar containers specifically')
})

test('the host refuses when the on-screen sidebar belongs to another conversation', () => {
  assert.match(HOST_SRC, /belongs to another conversation/,
    'the refusal must name the reason, so the human knows to switch back')
  // And it must be wired into the path every view goes through: one definition, one call.
  const calls = (HOST_SRC.match(/this\.sidebarOwnership\(\)/g) ?? []).length
  assert.equal(calls, 1, 'exactly one call site')
  const guestFor = HOST_SRC.slice(HOST_SRC.indexOf('private async guestFor'))
  assert.match(guestFor, /sidebarOwnership\(\)/,
    'guestFor is the single entry for every view, so the check has to be inside it')
})

test('it does not block a host that cannot name its conversation', () => {
  // An older DSH supplies no session id, so the owner stays a random uuid and requiring a match
  // would refuse every call. Losing the verification beats losing the feature.
  assert.match(HOST_SRC, /if \(!this\.owner\.startsWith\('session-'\)\) return \{ ok: true \}/)
})

test('the ownership decision is on the plugin side; the bridge only scopes its queries', () => {
  // Two different things live on two different sides, and the split is deliberate.
  //
  // The DECISION ("is the visible sidebar mine, and may I act") is in the host, because the bridge
  // is read once at host boot and a change there costs a restart. The SCOPING — every page script
  // running against this conversation's panel rather than the whole document — has to be in the
  // bridge, because that is where the scripts are built. No ownership verdict is made there.
  assert.ok(!/belongs to another conversation/.test(BRIDGE),
    'the bridge must not decide ownership; it has no session identity to compare with')
  assert.match(BRIDGE, /panelRootExpression/, 'but it scopes its DOM work to one panel')
  assert.match(BRIDGE, /evaluateInPanel/, 'every shell script goes through the scoped runner')
})
