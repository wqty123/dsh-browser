// The invariants of this session's fixes, re-derived from the code.
//
// Ten rounds passed without a restart, each finding something. That cannot go on: a process that
// always finds one more bug is not converging. So the invariants the fixes were meant to establish
// are written down here, and this suite fails the moment one of them stops holding — which is a
// different question from "is every line correct", and the one that says when to stop reading and
// start testing against the real thing.
//
// Each was broken at least once. The point is that they cannot break silently again.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'

const bridge = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
const host = readFileSync('src/browser-electron/desktop-bridge-host.ts', 'utf8')

function ops (source) {
  return [...source.matchAll(/if \(op === '([a-zA-Z]+)'\) \{/g)].map(match => {
    for (let end = source.indexOf('}', match.index); end !== -1; end = source.indexOf('}', end + 1)) {
      const body = source.slice(match.index, end + 1)
      try {
        // Parse, never execute. JavaScript itself handles braces in templates,
        // strings, comments and regexes; only a complete branch compiles.
        new Script(`async function operation() { ${body}\n }`)
        return { name: match[1], body }
      } catch { /* the branch has not ended yet */ }
    }
    throw new Error(`unclosed operation: ${match[1]}`)
  })
}

function ledgerOffenders (source) {
  const dispatch = source.slice(source.indexOf('async function dispatch('))
  const gate = dispatch.indexOf('const guest = boundGuest(request.handle)')
  return ['cdp', 'download', 'showTab', 'closePage'].filter(name =>
    gate === -1 || dispatch.indexOf(`if (op === '${name}')`) < gate)
}

test('every bound-guest operation resolves its canonical handle before dispatch', () => {
  const offenders = ledgerOffenders(bridge)
  assert.deepEqual(offenders, [], 'these ops touch guests without asking who is asking: ' + offenders.join(', '))
})

test('canonical gate scan catches removal of the shared binding resolver', () => {
  const branches = ops(bridge)
  assert.ok(!branches.find(op => op.name === 'collapseSidebar').body.includes('setWindowOpenHandler'))
  const bypass = bridge.replace('const guest = boundGuest(request.handle)', '')
  assert.notEqual(bypass, bridge)
  assert.deepEqual(ledgerOffenders(bypass), ['cdp', 'download', 'showTab', 'closePage'])
  assert.deepEqual(ops("if (op === 'one') { const s = `brace } ${1}`; /* } */ return /}/.test(s) }\nfunction later() { guestById(1) }").map(op => op.body),
    ["if (op === 'one') { const s = `brace } ${1}`; /* } */ return /}/.test(s) }"])
})

test('nothing in the bridge clicks or types into the shell any more', () => {
  // The mechanism of the reported bug was "do what a human does": press the shell's shortcut,
  // click the guide card, type into the address bar. Each of those reaches the conversation the
  // shell DISPLAYS, so each was a route into somebody else's sidebar. That path is gone; the ops
  // that still drive the sidebar do it by calling the shell's own operation.
  assert.ok(!/card\.click\(\)/.test(bridge), 'the launcher card is never clicked')
  const opening = bridge.slice(bridge.indexOf("if (op === 'ensureSidebar')"), bridge.indexOf("if (op === 'showTab')"))
  assert.ok(!/Input\.dispatchKeyEvent|sendInputEvent/.test(opening), 'sidebar opening never types a shell shortcut')
  assert.ok(!/shell\.sendInputEvent/.test(bridge), 'guest keyboard input never targets the desktop shell')
})

test('no CDP reply is stringified before its value is read', () => {
  const offenders = bridge.split('\n')
    .map((line, i) => ({ line: i + 1, code: line.replace(/\/\/.*$/, '') }))
    .filter(entry => /String\(\s*await\s+\w+\(/.test(entry.code))
  assert.deepEqual(offenders.map(o => 'L' + o.line), [],
    'String() on a response leaves .result undefined, so the reader answers undefined forever')
})

test('the superseded creation path is gone from the file', () => {
  // Removed rather than renamed: a legacy branch that still exists is a branch somebody can call
  // by hand, and this one opened pages into whatever conversation happened to be on screen.
  assert.ok(!/shellPrepareSidebar/.test(bridge), 'the card clicker is removed')
  assert.ok(!/legacyEnsureSidebar/.test(bridge), 'and so is the op that wrapped it')
  assert.ok(!/if \(op === 'ensureTabs'\)/.test(bridge), 'the counting-only tab op is removed')
})

test('guest allocation binds the canonical identity it returns', () => {
  const bindings = (bridge.match(/bindGuest\(/g) ?? []).length
  assert.ok(bindings >= 4)
  assert.doesNotMatch(bridge, /assertGuestOwner|claims\.set/)
})

test('guestFor opens a page for its own conversation, whatever is on screen', () => {
  assert.match(host, /private async guestFor/, 'the single entry point for every view')
  assert.match(host, /op: 'ensureSidebar'/, 'one call materializes the page')
  assert.match(host, /op: 'ensureSidebar', handle: id/)
  assert.ok(!/needsNewTab/.test(host), 'this carrier shows one page per conversation, not one per view')
  assert.ok(!/sidebarOwnership/.test(host), 'and nothing decides from the displayed conversation')
})

test('every gated op is called with a canonical handle from the host', () => {
  const gated = ['ensureSidebar', 'showTab', 'releaseSession']
  const missing = gated.filter(name => {
    // `owner` travels as shorthand on some calls and as a key on others; both are that field.
    const re = new RegExp("op: '" + name + "'[\\s\\S]{0,200}?handle\\s*[,:}]")
    return !re.test(host)
  })
  assert.deepEqual(missing, [], 'these are called without an owner and fail silently: ' + missing.join(', '))
})

test('the panel path asks the renderer, and names the conversation', () => {
  // The only side that knows which sidebar is whose is the renderer, because that is where the
  // shell keeps the session id. So the bridge asks it, by conversation id, and never looks at the
  // DOM to decide where a page goes.
  const lines = bridge.split('\n')
  const start = lines.findIndex(l => l.includes("if (op === 'ensureSidebar')"))
  assert.ok(start >= 0, 'ensureSidebar exists')
  const body = lines.slice(start, start + 80).join('\n')
  assert.match(body, /evaluatePanelService\(/, 'it asks the plugin client half for this conversation panel')
  assert.match(body, /\/\^session-\/\.test\(owner\)/, 'and refuses a caller that cannot name a conversation')
  const opening = body.slice(0, body.indexOf("if (op === 'collapseSidebar')"))
  assert.ok(!/document\.querySelector/.test(opening), 'no DOM query decides where the page goes')
})
