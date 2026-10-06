// The bridge's ownership rules, exercised without a shell.
//
// The bridge imports `electron` statically and drives real webContents, so testing it used to
// mean deploying into the running app and restarting it. That loop is why a bug in the retry
// loop opened a dozen tabs on a live sidebar before anyone saw it, and why the ownership rules
// were wrong twice — the paths that actually run (later calls, the reuse branch) were never
// exercised until a human hit them.
//
// This runs the REAL file: the electron import is rewritten to a stub and the two boot calls are
// cut, but nothing else is touched. `handle()` is then driven directly.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

class FakeContents extends EventEmitter {
  constructor (id, type, url = '') {
    super()
    this.id = id
    this.type = type
    this.url = url
    this.title = url
    // The real bridge attaches a debugger and answers over CDP. A stub without one makes every
    // `sendCdp` throw — which reads as "the code refused", for reasons that have nothing to do
    // with what a test is actually asserting.
    this.debugger = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: (method, params) => globalThis.__answerCdp__(this.id, method, params),
    }
    // The panel path reaches the shell through `executeJavaScript`; it resolves with the value
    // itself, not a CDP envelope.
    this.executeJavaScript = code => Promise.resolve(JSON.stringify(panelVerdict(String(code))))
  }
  getType () { return this.type }
  getTitle () { return this.title }
  getURL () { return this.url }
  isDestroyed () { return false }
  setWindowOpenHandler () {}
  close () {}
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

/**
 * What the shell's renderer answers when the bridge asks it to open a conversation's panel.
 *
 * The panel path evaluates a call on the plugin's client half and reads the verdict from the
 * reply, so this is where a test says what that conversation has.
 */
let panelVerdict = () => ({ ok: true, created: false, panel: true, guestId: 2, url: '' })

/** The CDP answers a shell would give. */
globalThis.__answerCdp__ = async (id, method, params) => {
  if (method === 'Runtime.evaluate' && String(params?.expression ?? '').includes('__dshBuiltinBrowser')) {
    return { result: { value: JSON.stringify(panelVerdict(String(params?.expression ?? ''))) } }
  }
  return { result: { value: 'OK' } }
}

/**
 * Load the bridge with its electron import stubbed and its boot calls removed.
 * @returns the module's `handle` and `claims`, which are what the tests drive.
 */
async function loadBridge () {
  let src = readFileSync(BRIDGE, 'utf8')
  src = src.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__')
  src = src.replace(/^start\(\)$/m, '')
  src = src.replace(/^main\(\)$/m, '')
  src += '\nglobalThis.__bridge_handle__ = handle;\nglobalThis.__bridge_claims__ = claims;\n'
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'bridge.mjs')
  writeFileSync(file, src)
  await import('file:///' + file.replace(/\\/g, '/'))
  return { handle: globalThis.__bridge_handle__, claims: globalThis.__bridge_claims__ }
}

const { handle, claims } = await loadBridge()
const shell = new FakeContents(1, 'window', 'dsh-app://app/')

test('list shows a session only its own guests, plus unclaimed ones', async () => {
  const a = new FakeContents(2, 'webview', 'https://a.example/')
  const b = new FakeContents(3, 'webview', 'https://b.example/')
  const free = new FakeContents(4, 'webview', 'https://free.example/')
  world.contents = [shell, a, b, free]
  claims.clear()
  claims.set(2, 'sessionA')
  claims.set(3, 'sessionB')

  const forA = (await handle({ op: 'list', owner: 'sessionA' })).sidebar.map(g => g.id)
  assert.deepEqual(forA, [2, 4], 'A sees its own guest and the unclaimed one, never B’s')

  const forB = (await handle({ op: 'list', owner: 'sessionB' })).sidebar.map(g => g.id)
  assert.deepEqual(forB, [3, 4])
})

test('two conversations asking in turn are each answered with their own page', async () => {
  // The bleed used to be possible because the request carried a process-level identity every
  // session shared, and the bridge then looked for a guest to hand it. Now the id IS the
  // conversation's own, the renderer resolves the panel from it, and there is no lookup in the
  // bridge to get wrong — the answer is whichever page that conversation's panel holds.
  const a = new FakeContents(2, 'webview', 'https://a.example/')
  const b = new FakeContents(3, 'webview', 'https://b.example/')
  world.contents = [shell, a, b]
  claims.clear()

  const asked = []
  panelVerdict = (expression) => {
    asked.push(expression)
    // Real conversation ids carry the `session-` prefix; the bridge refuses anything that cannot
    // name a conversation, so a bare 'sessionA' would be turned away before it got this far.
    return expression.includes('session-aaa')
      ? { ok: true, created: false, panel: true, guestId: 2, url: '' }
      : { ok: true, created: false, panel: true, guestId: 3, url: '' }
  }

  assert.equal((await handle({ op: 'ensureSidebar', owner: 'session-aaa' })).id, 2)
  assert.equal((await handle({ op: 'ensureSidebar', owner: 'session-bbb' })).id, 3)
  assert.equal(asked.length, 2, 'one question per call')
  assert.ok(asked[0].includes('session-aaa'), 'the first named session-aaa')
  assert.ok(asked[1].includes('session-bbb'), 'the second named session-bbb')
  assert.equal(claims.get(2), 'session-aaa', 'each guest is claimed by the conversation that asked')
  assert.equal(claims.get(3), 'session-bbb')
})

test('the bridge no longer scans the process for a free guest', () => {
  // It used to enumerate every webview looking for "one nobody has claimed", which is how a
  // session came to be handed a page a human had opened, or one another session owned. The guest
  // now comes from the conversation's own panel, so no scan exists for that to happen through.
  const source = readFileSync(BRIDGE, 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex(l => l.includes("if (op === 'ensureSidebar')"))
  assert.ok(start >= 0, 'ensureSidebar exists')
  const body = lines.slice(start, start + 80).join('\n')
  assert.ok(!/unclaimed/.test(body), 'no notion of an unclaimed tab remains in this op')
  assert.ok(!/getType\(\) === 'webview'/.test(body), 'and it never enumerates guests looking for one')
})

test('showTab refuses a guest another session holds', async () => {
  const a = new FakeContents(2, 'webview', 'https://a.example/')
  world.contents = [shell, a]
  claims.clear()
  claims.set(2, 'sessionA')
  await assert.rejects(
    () => handle({ op: 'showTab', viewId: 2, owner: 'sessionB' }),
    /another session/,
  )
})

test('closeSidebarBrowser never considers another session’s guest', async () => {
  // The worst form of the bleed: not seeing someone else's tab, but closing it. A reset in one
  // session used to be able to tear down another session's page.
  const a = new FakeContents(2, 'webview', 'https://a.example/')
  const b = new FakeContents(3, 'webview', 'https://b.example/')
  world.contents = [shell, a, b]
  claims.clear()
  claims.set(2, 'sessionA')
  claims.set(3, 'sessionB')

  try {
    await handle({ op: 'closeSidebarBrowser', titles: [], owner: 'sessionB' })
  } catch {
    // Driving the DOM needs a real shell; the assertion is about which guests were eligible.
  }
  assert.equal(claims.get(2), 'sessionA', 'A still holds its guest')
})

test('a waiting call keeps asking about its own conversation, and nothing else', async () => {
  // The wait exists because a guest attaches asynchronously once the renderer creates the
  // webview. Every round asks the SAME question — this conversation's panel — so a guest
  // appearing in any other conversation cannot satisfy it. The old wait compared sets of every
  // webview in the process, which is exactly how it could.
  let reads = 0
  const asked = []
  panelVerdict = (expression) => {
    asked.push(expression)
    reads += 1
    return reads === 1
      ? { ok: true, created: true, panel: true, guestId: null }
      : { ok: true, created: false, panel: true, guestId: 9, url: '' }
  }

  const answer = await handle({ op: 'ensureSidebar', owner: 'session-ccc' })
  assert.equal(answer.id, 9, 'the page that eventually appeared is the one returned')
  assert.equal(answer.created, true, 'and the caller is told a tab was placed')
  assert.ok(asked.length >= 2, 'it polled rather than giving up after one read')
  for (const expression of asked) {
    assert.ok(expression.includes('session-ccc'), 'every round asked about this conversation only')
  }
})

test('the shell shortcut is simulated nowhere in the file', () => {
  // Ctrl+T is the shell's binding for browser.new, and the shell delivers it to whatever it is
  // displaying. That property is why it could not be the mechanism — and why a page asked for
  // from one conversation landed in another. Assert no branch reaches for it any more.
  const source = readFileSync(BRIDGE, 'utf8')
  assert.ok(!/request\.newTab === true/.test(source), 'no branch keys off newTab any more')
  assert.ok(!/Input\.dispatchKeyEvent/.test(source), 'and no key event is dispatched anywhere')
  assert.ok(!/shellPrepareSidebar/.test(source), 'the launcher-card clicker is removed')
})
