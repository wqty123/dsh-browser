// The guard that keeps the bridge out of somebody else's sidebar.
//
// Measured on the running desktop: two `[class*=_tabStrip]` containers sat in the DOM at once,
// each carrying its own session id on the React fiber, and the shell only operates the visible
// one. Without a check, an operation issued while the human was reading another conversation
// typed into THAT conversation's address bar and navigated its page — which is exactly what
// happened here.
//
// `sidebarState()` asks the shell: does a container belong to me, and is it on screen? The four
// cases below are the whole contract, and the two dangerous ones assert clicks === 0 rather than
// merely an error, because "it complained but typed anyway" would be the same bug.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

class FakeContents extends EventEmitter {
  constructor (id, type) { super(); this.id = id; this.type = type; this.title = '' }
  getType () { return this.type }
  getTitle () { return this.title }
  getURL () { return '' }
  isDestroyed () { return false }
  setWindowOpenHandler () {}
  close () {}
}

const world = { contents: [new FakeContents(1, 'window')] }
const noop = () => {}
const asyncNoop = async () => {}
globalThis.__electronStub__ = {
  app: { whenReady: asyncNoop, on: noop, getPath: () => 'D:/tmp', quit: noop },
  ipcMain: { on: noop },
  BrowserWindow: class { static getAllWindows () { return [] } },
  webContents: {
    getAllWebContents: () => world.contents,
    fromId: (id) => world.contents.find(c => c.id === id),
  },
}

let src = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
src = src.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__')
src = src.replace(/^start\(\)$/m, '').replace(/^main\(\)$/m, '')
src = src.replace(
  'async function sendCdp(id, method, params) {',
  'async function sendCdp(id, method, params) { return globalThis.__a__(method, params) }\nasync function __u(id, method, params) {',
)
src += '\nglobalThis.__h__ = handle;\nglobalThis.__c__ = claims;\n'

/** What the fake shell reports, and how many times the launcher card was clicked. */
const shell = { verdict: 'visible', visibleSession: null, clicks: 0 }

globalThis.__a__ = async (method, params) => {
  const expression = String(params?.expression ?? '')
  if (expression.includes('__reactFiber')) {
    return {
      result: {
        value: JSON.stringify({
          verdict: shell.verdict,
          containers: 2,
          heldBy: ['session-other'],
          visibleSession: shell.visibleSession,
        }),
      },
    }
  }
  if (expression.includes('card.click()')) { shell.clicks += 1; return { result: { value: 'CLICKED_CARD' } } }
  if (expression.includes("? 'YES' : 'NO'")) return { result: { value: 'NO' } }
  return { result: { value: 'OK' } }
}

const dir = mkdtempSync(join(tmpdir(), 'guard-'))
const file = join(dir, 'b.mjs')
writeFileSync(file, src)
await import('file:///' + file.replace(/\\/g, '/'))

const handle = globalThis.__h__
const claims = globalThis.__c__

/** Run one ensureSidebar against the current fake shell state. */
async function attempt (owner) {
  claims.clear()
  shell.clicks = 0
  try {
    await handle({ op: 'ensureSidebar', owner })
    return { threw: '', clicks: shell.clicks }
  } catch (error) {
    return { threw: String(error.message), clicks: shell.clicks }
  }
}

test('our own sidebar on screen: the guard lets the call through', async () => {
  shell.verdict = 'visible'
  shell.visibleSession = 'session-mine'
  const result = await attempt('session-mine')
  assert.ok(!/another conversation/.test(result.threw), 'the guard must not block our own sidebar')
  assert.equal(result.clicks, 1, 'and the call must reach the launcher card')
})

test('another conversation on screen: refuses AND touches nothing', async () => {
  shell.verdict = 'absent'
  shell.visibleSession = 'session-theirs'
  const result = await attempt('session-mine')
  assert.match(result.threw, /belongs to another conversation/)
  assert.equal(result.clicks, 0, 'complaining is not enough — it must not type into their panel')
})

test('our sidebar hidden behind theirs: refuses AND touches nothing', async () => {
  shell.verdict = 'hidden'
  shell.visibleSession = 'session-theirs'
  const result = await attempt('session-mine')
  assert.match(result.threw, /belongs to another conversation/)
  assert.equal(result.clicks, 0)
})

test('a host that cannot name its session is not blocked by the guard', async () => {
  // The fallback path: a random uuid has no session id to match, so requiring one would refuse
  // everything. The guard is skipped rather than breaking the feature.
  shell.verdict = 'absent'
  shell.visibleSession = null
  const result = await attempt('a-random-uuid')
  assert.ok(!/belongs to another conversation/.test(result.threw))
})
