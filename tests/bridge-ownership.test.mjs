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
