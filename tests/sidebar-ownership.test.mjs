// The guard that keeps an operation inside one conversation's sidebar.
//
// Measured on the running desktop: two `[class*=_tabStrip]` containers sit in the DOM at once,
// each carrying its own session id, and the shell operates only the one it displays. Driving "the
// displayed one" is the reported bug — an operation issued while the human read another
// conversation typed into THAT conversation's address bar and navigated its page.
//
// Two mechanisms used to guard that, and both are gone:
//
//   * the host probed the shell for the displayed conversation and refused when it was not us —
//     which is a refusal, not a fix: the page still did not open;
//   * the bridge scoped its DOM work to this conversation's panel, which was correct but only
//     ever applied to a panel that already existed.
//
// The fix is that nothing decides from the screen any more. The plugin's client half asks the
// shell to open the panel OF A NAMED CONVERSATION (`openTabIn`), which does not read what is
// displayed at all, and reports that panel's own guest. These tests hold that shape: no screen
// probe in the host, no identity comparison to make, and one named call on the bridge side.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const HOST_SRC = readFileSync('src/browser-electron/desktop-bridge-host.ts', 'utf8')
const BRIDGE = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
const CLIENT = readFileSync('client.js', 'utf8')

test('the host makes no decision from what the shell is displaying', () => {
  // Every way this used to be asked is gone. If any of these names comes back, so does the
  // screen as an input to the decision — and with it the refusal the user actually reported.
  for (const gone of ['sidebarOwnership', 'SIDEBAR_OWNERSHIP_PROBE', '__reactFiber', '_tabStrip', 'belongs to another conversation']) {
    assert.ok(!HOST_SRC.includes(gone), `the host must no longer contain "${gone}"`)
  }
})

test('guestFor still names the conversation it is opening a page for', () => {
  const guestFor = HOST_SRC.slice(HOST_SRC.indexOf('private async guestFor'))
  assert.match(guestFor, /op: 'ensureSidebar'/, 'the one call that materializes a page')
  // The owner comes from the VIEW. One host instance serves every conversation, so a process-level
  // owner could only ever be one conversation's id applied to all of them — which is how a page
  // asked for in one conversation could still turn up in another's sidebar.
  assert.match(guestFor, /const owner = entry\?\.owner \?\? this\.owner/,
    'the owner is the view\'s conversation')
  assert.ok(!/needsNewTab/.test(guestFor),
    'and no longer distinguishes the first view from later ones: this carrier shows one page per conversation')
})

test('the bridge opens a panel by conversation id, through the plugin client half', () => {
  const lines = BRIDGE.split('\n')
  const start = lines.findIndex(l => l.includes("if (op === 'ensureSidebar')"))
  assert.ok(start >= 0, 'ensureSidebar exists')
  const body = lines.slice(start, start + 80).join('\n')
  assert.match(body, /evaluatePanelService\(/, 'the renderer is asked for this conversation panel')
  assert.match(body, /\/\^session-\/\.test\(owner\)/, 'a caller that cannot name a conversation is refused')
  assert.ok(!/document\.querySelector/.test(body), 'no DOM query decides where the page goes')
})

test('the panel service is the only thing that knows which sidebar is whose', () => {
  // It lives in the client half because that is the side the shell tells the session id to. The
  // bridge and the host hold no comparable identity, which is exactly why neither may decide.
  assert.match(CLIENT, /globalThis\.__dshBuiltinBrowser/, 'the service is published where the bridge can reach it')
  assert.match(CLIENT, /openTabIn\(/, 'and it opens a panel through the conversation-scoped call')
  assert.ok(!/openTab\(/.test(CLIENT.replace(/openTabIn\(/g, '')),
    'never through `openTab`, which acts on the conversation the shell displays')
  assert.match(CLIENT, /panelRootFor|tabStripFor/, 'the panel is found by conversation id, not by document order')
})

test('the bridge keeps the scoping its remaining DOM ops still need', () => {
  // `showTab`, `closeSidebarBrowser` and `collapseSidebar` still run page scripts, and those must
  // stay inside this conversation's panel. Removing the panel scoping was never the goal.
  assert.match(BRIDGE, /panelRootExpression/, 'page scripts are scoped to one panel')
  assert.match(BRIDGE, /evaluateInPanel/, 'and every one of them goes through the scoped runner')
})
