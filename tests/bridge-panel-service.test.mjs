// The bridge's panel path: one conversation's own sidebar, opened by name.
//
// This replaces `bridge-card-clicks.test.mjs`, whose subject was the old path — Ctrl+T, then a
// click on the 「浏览器」guide card, then typing into the address bar. Counting those clicks was
// the right test for it, and the count was never the real defect: the defect was that all three
// land on the conversation the shell is DISPLAYING. A page asked for while the human read another
// conversation went into THAT one, waiting for the screen to come back cost ten seconds, and the
// retry loop left a tab per round.
//
// So the new path has no clicks and no keys to count, and these tests assert exactly that: the
// bridge evaluates one call on the global the plugin's own client half publishes, that call
// carries the CALLING conversation id, and nothing is dispatched into the input system.
//
// The electron import is stubbed and `sendCdp` is replaced with a scripted answer, so the real
// file runs and `handle()` is driven directly — same harness shape as the ownership suite.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tabWireId } from '../lib/browser/handles.js'
const wire = owner => tabWireId({ owner, session: 'browser:test', tab: 'v1' })

class FakeContents extends EventEmitter {
  constructor (id, type, url = '') {
    super()
    this.id = id
    this.type = type
    this.url = url
    this.title = url
  }
  getType () { return this.type }
  getTitle () { return this.title }
  getURL () { return this.url }
  isDestroyed () { return false }
  setWindowOpenHandler () {}
  close () {}
  // The panel path evaluates on the shell through `executeJavaScript`, not through the debugger.
  // Measured on the running shell: the debugger attachment to the WINDOW hangs for minutes while
  // the same channel to a guest page answers at once — so the shell no longer uses it at all.
  executeJavaScript (code) { return globalThis.__evalInShell__(this.id, code) }
}

const world = { contents: [] }

globalThis.__electronStub__ = {
  app: { whenReady: async () => {}, on () {}, getPath: () => 'D:/tmp', quit () {} },
  ipcMain: { on () {} },
  BrowserWindow: class { static getAllWindows () { return [] } },
  webContents: {
    getAllWebContents: () => world.contents,
    fromId: (id) => world.contents.find(c => c.id === id),
  },
}

const BRIDGE = new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url)

let src = readFileSync(BRIDGE, 'utf8')
src = src.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__')
src = src.replace(/^start\(\)$/m, '')
src = src.replace(/^main\(\)$/m, '')

// The signature must match the source EXACTLY, or the patch silently does nothing and every
// scenario reads as "the code was correct". The previous harness lost the id here too; this one
// keeps it, because the panel path is judged by WHICH webContents it evaluates in.
const SIGNATURE = 'async function sendCdp(id, method, params, checkCurrent) {'
assert.ok(src.includes(SIGNATURE), 'sendCdp signature changed; this harness would silently no-op')
src = src.replace(
  SIGNATURE,
  'async function sendCdp(id, method, params, checkCurrent) { checkCurrent?.(); return globalThis.__answerCdp__(id, method, params) }\n'
  + 'async function __unusedRealSendCdp(id, method, params) {',
)
src += '\nglobalThis.__bridge_handle__ = handle;\nglobalThis.__bridge_handles__ = handles;\n'

/** Everything the harness observed, reset per scenario. */
const seen = { evaluates: [], reads: [], placements: [], navigations: [], keys: [], clicks: [] }

/**
 * Scripted shell.
 * @param panel - a verdict, or a function of the read count so a scenario can go from "no guest
 *   yet" to "the guest attached" the way a real renderer does.
 * @param guest - the webContents the panel reports; registered on first ask, so `guestById` can
 *   find it for the URL comparison.
 */
let panelScript = () => ({ ok: true, created: true, panel: true, guestId: null })
let panelGuest = null
let cancelInitialization = () => false

/**
 * The shell answering a page script.
 *
 * `executeJavaScript` resolves with the value itself, not a CDP envelope, so this returns the
 * verdict string directly — and registers the guest the panel will report, since a real renderer
 * attaches one asynchronously after the tab is placed.
 */
globalThis.__evalInShell__ = async (id, code) => {
  if (code.includes('api?.holdRendering')) return false
  seen.evaluates.push({ id, expression: code })
  if (code.includes('cancelPanelInitialization')) return cancelInitialization(code)
  if (code.includes('.click(')) seen.clicks.push(code)
  // `panelGuest` is the READ form and `openPanel` the one that CREATES. Keeping them apart here is
  // what lets the suite assert that a wait never places anything.
  if (code.includes('panelGuest')) {
    seen.reads.push(code)
    // What the conversation holds RIGHT NOW. A placement that already happened is visible to a
    // read — that is precisely why the wait polls with the read form, and a stub that always
    // answered "nothing" would make every wait run to its deadline.
    const placed = panelGuest !== null && seen.placements.length > 0
    return JSON.stringify({
      ok: true,
      panel: true,
      guestId: placed ? panelGuest.id : null,
      url: placed ? panelGuest.url : '',
    })
  }
  seen.placements.push(code)
  const verdict = await panelScript(seen.placements.length)
  if (panelGuest !== null && !world.contents.includes(panelGuest)) world.contents.push(panelGuest)
  return JSON.stringify(verdict)
}

/** The CDP answers a shell would give for the guest path. */
globalThis.__answerCdp__ = async (id, method, params) => {
  if (method === 'Input.dispatchKeyEvent') {
    seen.keys.push(params)
    return { result: { value: 'DISPATCHED' } }
  }
  if (method === 'Runtime.evaluate') {
    const expression = String(params?.expression ?? '')
    if (expression.includes('.click(')) seen.clicks.push(expression)
    return { result: { value: 'OK' } }
  }
  if (method === 'Page.navigate') {
    seen.navigations.push({ id, params })
    return { result: { value: 'OK' } }
  }
  if (method === 'Page.getNavigationHistory') return { entries: [{ url: panelGuest.url, userTypedURL: panelGuest.url }], currentIndex: 0 }
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'doc-1', url: panelGuest.url } } }
  return { result: { value: 'OK' } }
}

const folder = mkdtempSync(join(tmpdir(), 'panel-'))
const file = join(folder, 'bridge.mjs')
writeFileSync(file, src)
writeFileSync(join(folder, 'guest-proxy.mjs'), readFileSync(new URL('../desktop-bridge/guest-proxy.mjs', import.meta.url)))
writeFileSync(join(folder, 'native-guests.mjs'), readFileSync(new URL('../desktop-bridge/native-guests.mjs', import.meta.url)))
await import('file:///' + file.replace(/\\/g, '/'))

const handle = globalThis.__bridge_handle__
const handles = globalThis.__bridge_handles__
const shell = new FakeContents(1, 'window', 'dsh-app://app/')
world.contents = [shell]

/** Reset the harness for one scenario. */
function reset (script, guest = null) {
  handles.clear()
  panelScript = script
  panelGuest = guest
  cancelInitialization = () => false
  seen.evaluates.length = 0
  seen.reads.length = 0
  seen.placements.length = 0
  seen.navigations.length = 0
  seen.keys.length = 0
  seen.clicks.length = 0
  world.contents = [shell]
}

test('a conversation with no page gets one, and the call carries its own id', async () => {
  const guest = new FakeContents(7, 'webview', 'https://example.com/')
  reset(async () => {
    await new Promise(resolve => setImmediate(resolve))
    return { ok: true, created: true, panel: true, guestId: 7, url: 'https://example.com/', rendererNavigation: true, initialization: { stage: 'attached', guestId: '7' } }
  }, guest)

  const answer = await handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://example.com/' })

  assert.equal(answer.ok, true)
  assert.equal(answer.id, wire('session-a'), 'the guest the panel produced is the one reported')
  assert.equal(answer.created, true, 'and the caller is told a tab was placed')
  assert.equal(answer.navigation.frameId, 'main')
  assert.equal(answer.navigation.loaderId, 'doc-1')
  assert.equal(seen.placements.length, 1)
  assert.equal(seen.navigations.length, 0, 'the acknowledged native navigation is not replayed')

  assert.ok(seen.evaluates.length >= 1, 'the renderer was asked for this conversation panel')
  for (const read of seen.evaluates) {
    assert.equal(read.id, 1, 'the question is put to the shell window')
    assert.ok(read.expression.includes('"session-a"'),
      'and it names the CALLING conversation, never whatever is on screen')
  }
  assert.deepEqual(seen.keys, [], 'no key is dispatched into the input system')
  assert.deepEqual(seen.clicks, [], 'and no element is clicked')
  assert.equal(handles.get(wire('session-a'))?.owner, 'session-a', 'the produced guest is claimed by its conversation')
})

test('a superseded sidebar open cannot navigate the guest attached for its successor', async () => {
  const oldUrl = 'https://example.test/first'
  const newUrl = 'https://example.test/second'
  const guest = new FakeContents(7, 'webview', 'about:blank')
  const target = { op: 'ensureSidebar', handle: wire('session-a') }
  let release
  reset(async placement => {
    if (placement === 1) await new Promise(resolve => { release = resolve })
    return { ok: true, panel: true, guestId: 7 }
  }, guest)

  const old = assert.rejects(handle({ ...target, url: oldUrl }), { code: 'panel-navigation-superseded' })
  await new Promise(resolve => setImmediate(resolve))
  const latest = await handle({ ...target, url: newUrl })
  release()
  await old

  assert.equal(latest.id, wire('session-a'))
  assert.deepEqual(seen.navigations, [{ id: 7, params: { url: newUrl } }])
})

test('a cancelled transaction cannot claim or navigate its late guest', async () => {
  let release
  const target = { handle: wire('session-a'), transactionId: 'request-one' }
  const guest = new FakeContents(7, 'webview', 'about:blank')
  reset(() => new Promise(resolve => { release = () => resolve({ ok: true, panel: true, guestId: 7 }) }), guest)
  cancelInitialization = code => { assert.ok(code.includes('request-one')); release(); return true }
  const rejected = assert.rejects(handle({ op: 'ensureSidebar', ...target, url: 'https://cancelled.example/' }), { code: 'BROWSER_NAVIGATION_CANCELLED' })
  await new Promise(resolve => setImmediate(resolve))
  const stale = await handle({ op: 'cancelSidebar', ...target, transactionId: 'stale' })
  assert.equal(stale.cancelled, false)
  const foreign = await handle({ op: 'cancelSidebar', ...target, handle: wire('session-other') })
  assert.equal(foreign.cancelled, false)
  const cancelled = await handle({ op: 'cancelSidebar', ...target })
  assert.equal(cancelled.cancelled, true)
  await rejected
  assert.equal(handles.has(wire('session-a')), false)
  assert.deepEqual(seen.navigations, [])
})

for (const receipt of [undefined, {}, { stage: 'attached', guestId: '8' }]) {
  test(`a missing or foreign initialization identity is refused: ${JSON.stringify(receipt)}`, async () => {
    const guest = new FakeContents(7, 'webview', 'https://example.com/')
    reset(() => ({ ok: true, created: true, panel: true, guestId: 7, initialization: receipt }), guest)
    await assert.rejects(handle({ op: 'ensureSidebar', handle: wire('session-a'), url: guest.url }), { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' })
    assert.equal(handles.has(wire('session-a')), false)
    assert.deepEqual(seen.navigations, [])
  })
}

test('an existing page is reused without navigating it again', async () => {
  const guest = new FakeContents(7, 'webview', 'https://example.com/')
  reset(() => ({ ok: true, created: false, panel: true, guestId: 7, url: 'https://example.com/' }), guest)

  const answer = await handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://example.com/' })

  assert.equal(answer.id, wire('session-a'))
  assert.equal(answer.created, false, 'nothing new was placed')
  assert.equal(seen.evaluates.length, 1, 'one question, one answer — no polling when a page exists')
  assert.deepEqual(seen.navigations, [], 'the page already shows the address, so it is left alone')
})

test('a page showing something else is navigated, and only that page', async () => {
  const guest = new FakeContents(7, 'webview', 'https://old.example/')
  reset(() => ({ ok: true, created: false, panel: true, guestId: 7, url: 'https://old.example/' }), guest)

  const answer = await handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://new.example/' })

  assert.equal(answer.id, wire('session-a'))
  assert.equal(seen.navigations.length, 1, 'exactly one navigation')
  assert.equal(seen.navigations[0].id, 7, 'to the guest this conversation owns')
  assert.equal(seen.navigations[0].params.url, 'https://new.example/')
})

test('a renderer refusal is surfaced with its reason, not swallowed', async () => {
  reset(() => ({ ok: false, reason: 'this conversation\'s sidebar is not mounted, so a panel cannot be opened in it', panel: false, guestId: null }))

  await assert.rejects(
    () => handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://example.com/' }),
    /not mounted/,
    'the caller sees why nothing opened',
  )
  assert.deepEqual(seen.keys, [], 'and still nothing was typed or pressed')
})

test('a host that cannot name its conversation is refused instead of guessed at', async () => {
  reset(() => ({ ok: true, created: false, panel: true, guestId: 7, url: 'https://example.com/' }))

  for (const owner of ['anonymous', 'default', '', undefined]) {
    seen.evaluates.length = 0
    await assert.rejects(
      () => handle({ op: 'ensureSidebar', handle: owner ? wire(owner) : undefined, url: 'https://example.com/' }),
      /no conversation id|invalid/,
      `${String(owner)} must not be resolved to some panel`,
    )
    assert.equal(seen.evaluates.length, 0, 'nothing was even asked, because there was nothing to ask about')
  }
})

test('the client half missing from the window is a named failure', async () => {
  reset(() => ({ ok: false, reason: 'the plugin client half is not loaded in this window', panel: false, guestId: null }))

  await assert.rejects(
    () => handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://example.com/' }),
    /client half is not loaded/,
  )
})

test('a panel that never produces a page fails within its budget', async () => {
  // The renderer keeps accepting the request and never reports a guest: the sidebar was told to
  // open a tab and nothing attached. The call must end, and say so — the old path ended by
  // clicking the card again on every round.
  reset(() => ({ ok: true, created: true, panel: true, guestId: null }))

  const started = Date.now()
  await assert.rejects(
    () => handle({ op: 'ensureSidebar', handle: wire('session-a') }),
    { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 8_000, 'a no-url request uses the short budget; it took ' + String(elapsed) + 'ms')
  assert.deepEqual(seen.clicks, [], 'and it never fell back to clicking anything')
})

test('a missing guest acknowledgement refuses without a polling fallback', async () => {
  reset(() => ({ ok: true, created: true, panel: true, guestId: null }))

  await assert.rejects(
    () => handle({ op: 'ensureSidebar', handle: wire('session-a'), url: 'https://example.com/' }),
    { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' },
  )

  assert.equal(seen.placements.length, 1, 'exactly ONE placement, however long the wait was')
  assert.equal(seen.reads.length, 0, 'there are no independent polling reads')
  for (const read of seen.reads) {
    // The CALL, not the name: every expression carries `typeof api.openPanel !== 'function'` as a
    // capability check, so a substring test for the name would fail on a correct read.
    assert.ok(read.includes('api.panelGuest('), 'reads call panelGuest')
    assert.ok(!read.includes('api.openPanel('), 'and never call the creating form')
  }
})

test('the old path is gone from the file, not merely unreachable', () => {
  // Static, and deliberately so: a legacy branch that still exists is a branch somebody can call
  // by hand, and this one opens pages into whatever conversation happens to be on screen.
  const source = readFileSync(BRIDGE, 'utf8')
  assert.ok(!/legacyEnsureSidebar/.test(source), 'the superseded op is removed, not renamed')
  assert.ok(!/shellPrepareSidebar/.test(source), 'the launcher-card clicker is removed')
  assert.ok(!/card\.click\(\)/.test(source), 'no launcher card is clicked anywhere')
  const opening = source.slice(source.indexOf("if (op === 'ensureSidebar')"), source.indexOf("if (op === 'showTab')"))
  assert.ok(!/Input\.dispatchKeyEvent|sendInputEvent/.test(opening), 'opening the sidebar uses its service rather than a shortcut')
  assert.ok(!/if \(op === 'ensureTabs'\)/.test(source), 'the counting-only tab op is removed too')
})
