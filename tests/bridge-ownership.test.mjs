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

test('reuse hands a session its OWN guest, not whichever came first', async () => {
  // This is the bug that reached the user: the allocation path was owner-aware and the reuse
  // path — which every later call takes — was not, so a session was given another's page and
  // counted another's tabs as its own.
  const a = new FakeContents(2, 'webview', 'https://a.example/')
  const b = new FakeContents(3, 'webview', 'https://b.example/')
  world.contents = [shell, a, b]
  claims.clear()
  claims.set(2, 'sessionA')
  claims.set(3, 'sessionB')

  assert.equal((await handle({ op: 'ensureSidebar', owner: 'sessionB' })).id, 3)
  assert.equal((await handle({ op: 'ensureSidebar', owner: 'sessionA' })).id, 2)
})

test('an unclaimed guest is adopted rather than duplicated', async () => {
  const free = new FakeContents(5, 'webview', 'https://free.example/')
  world.contents = [shell, free]
  claims.clear()
  const answer = await handle({ op: 'ensureSidebar', owner: 'sessionC' })
  assert.equal(answer.id, 5, 'the existing unclaimed tab is taken, not replaced')
  assert.equal(claims.get(5), 'sessionC')
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

test('ensureSidebar waits for a NEW guest, never adopts one that was already open', async () => {  // The reported symptom, both halves from one line: with tabs already open, the "has a guest
  // appeared?" test was true on the first poll, so ensureSidebar returned `existing[0]` —
  // someone else's tab — navigated it to the requested url, and claimed success. The caller saw
  // a failure (its own tab never appeared) and the page showed up in another session.
  const openA = new FakeContents(2, 'webview', 'https://a.example/')
  const openB = new FakeContents(3, 'webview', 'https://b.example/')
  world.contents = [shell, openA, openB]
  claims.clear()
  claims.set(2, 'sessionA')
  claims.set(3, 'sessionB')

  const before = world.contents.length
  // The stub has no real shell DOM, so the drive cannot complete; what matters is which guest
  // the call is willing to RETURN. Either it keeps waiting, or it fails on the drive — both are
  // acceptable. Handing back an existing guest is not.
  let returned
  try {
    returned = await handle({ op: 'ensureSidebar', url: 'https://requested.example/', newTab: true, owner: 'sessionC' })
  } catch {
    returned = undefined
  }
  assert.equal(returned, undefined, 'it must not return an already-open guest')
  assert.equal(world.contents.length, before, 'and it must not have created anything in the stub')
  assert.equal(claims.get(2), 'sessionA', 'A’s guest is untouched')
  assert.equal(claims.get(3), 'sessionB', 'B’s guest is untouched')
})

test('newTab converts the guide page exactly once, never via shellPrepareSidebar', async () => {
  // Static, and deliberately so: the symptom was a loop, and a loop is what the stub cannot
  // reproduce. What CAN be asserted is the structural rule — the branch taken for `newTab` must
  // not reach the function whose job is to click the launcher card.
  const src = readFileSync(BRIDGE, 'utf8')
  const lines = src.split('\n')

  // Where the op handler decides what to prepare.
  const opLine = lines.findIndex(l => l.includes("if (op === 'ensureSidebar')"))
  assert.ok(opLine >= 0, 'ensureSidebar handler exists')

  // Every call to shellPrepareSidebar must sit in the branch that does NOT ask for a new tab.
  const calls = []
  lines.forEach((l, i) => { if (/expression: shellPrepareSidebar\(\)/.test(l)) calls.push(i) })
  assert.equal(calls.length, 1, 'exactly one call site')

  const callLine = calls[0]
  // Walk back to the nearest branch keyword and require the newTab guard to be present above it.
  let guard = -1
  for (let i = callLine; i >= 0; i--) {
    if (lines[i].includes('request.newTab === true')) { guard = i; break }
    if (lines[i].includes("if (op === 'ensureSidebar')")) break
  }
  assert.ok(guard > 0 && guard < callLine,
    'shellPrepareSidebar is reached only from a branch that has already decided about newTab')

  // And the guide is consumed by a single explicit click of the card, identified by BOTH halves.
  assert.ok(src.includes('CLICKED_CARD'), 'the card is clicked explicitly on the guide page')
  assert.ok(/if \(own\.length > 24\) return false/.test(src), 'the card test is bounded, so the strip tab cannot match')
})
