// The bridge's DOM paths, driven with fake page answers.
//
// The ownership suite drives `handle()` but its page scripts no-op, so every DOM branch was
// untested; the acceptance script exercises them only against a real shell. This sits between:
// `sendCdp` is replaced with a stub that answers the way a shell would, and the clicks are
// COUNTED — because the recurring failure in this session was not a wrong answer, it was a right
// answer given too many times (a dozen tabs; then two pages from two routes).
//
// Writing it found a live bug: with an address bar already present and no url, the no-url route
// clicked the launcher card anyway and made a second page.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

class FakeContents extends EventEmitter {
  constructor (id, type) {
    super()
    this.id = id
    this.type = type
    this.title = ''
  }
  getType () { return this.type }
  getTitle () { return this.title }
  getURL () { return '' }
  isDestroyed () { return false }
  setWindowOpenHandler () {}
  close () {}
}

const world = { contents: [] }
const page = { clicks: 0, addressBar: false, restores: 0 }

globalThis.__electronStub__ = {
  app: { whenReady: async () => {}, on () {}, getPath: () => 'D:/tmp', quit () {} },
  ipcMain: { on () {} },
  BrowserWindow: class { static getAllWindows () { return [] } },
  webContents: {
    getAllWebContents: () => world.contents,
    fromId: (id) => world.contents.find(c => c.id === id),
  },
}

let src = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
src = src.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__')
src = src.replace(/^start\(\)$/m, '')
src = src.replace(/^main\(\)$/m, '')

// The signature must match the source EXACTLY. The first attempt wrote `sendCdp (id,` with a
// space, patched nothing, and every scenario reported zero clicks — which looked like the code
// was correct. Assert it, so a rename breaks this loudly instead of silently.
const SIGNATURE = 'async function sendCdp(id, method, params) {'
assert.ok(src.includes(SIGNATURE), 'sendCdp signature changed; this harness would silently no-op')
src = src.replace(
  SIGNATURE,
  'async function sendCdp(id, method, params) { return globalThis.__answerCdp__(method, params) }\n'
  + 'async function __unusedRealSendCdp(id, method, params) {',
)
src += '\nglobalThis.__bridge_handle__ = handle;\nglobalThis.__bridge_claims__ = claims;\n'

globalThis.__answerCdp__ = async (method, params) => {
  const expression = String(params?.expression ?? '')
  if (expression.includes('card.click()')) {
    page.clicks += 1
    return { result: { value: 'CLICKED_CARD' } }
  }
  if (expression.includes('恢复') || expression.includes('restore')) {
    page.restores += 1
    return { result: { value: 'NO_RESTORE' } }
  }
  if (expression.includes('getBoundingClientRect') && expression.includes('HTTP')) {
    return { result: { value: page.addressBar ? 'YES' : 'NO' } }
  }
  return { result: { value: 'OK' } }
}

const dir = mkdtempSync(join(tmpdir(), 'card-'))
const file = join(dir, 'bridge.mjs')
writeFileSync(file, src)
await import('file:///' + file.replace(/\\/g, '/'))

const handle = globalThis.__bridge_handle__
const claims = globalThis.__bridge_claims__
const shell = new FakeContents(1, 'window')
world.contents = [shell]

/** Run one scenario against a fresh ledger. @returns how many times the card was clicked. */
async function run (request, answer) {
  claims.clear()
  page.clicks = 0
  page.restores = 0
  page.addressBar = answer.addressBar
  try {
    await handle({ op: 'ensureSidebar', owner: 's1', ...request })
  } catch { /* the stub cannot finish a real open; the click count is the point */ }
  return page.clicks
}

test('the first open (no url) clicks the launcher card exactly once', async () => {
  const clicks = await run({}, { addressBar: false })
  assert.equal(clicks, 1, 'the host\'s first call has no url and must still create a page')
})

test('newTab with an address bar already visible clicks NOTHING', async () => {
  const clicks = await run({ newTab: true }, { addressBar: true })
  assert.equal(clicks, 0, 'a page already exists; clicking would create a second one')
})

test('newTab on a guide page clicks the card exactly once', async () => {
  const clicks = await run({ newTab: true, url: 'https://example.com/' }, { addressBar: false })
  assert.equal(clicks, 1)
})

test('newTab with no url clicks the card exactly once, not twice', async () => {
  // Both routes are eligible here. They must not both fire.
  const clicks = await run({ newTab: true }, { addressBar: false })
  assert.equal(clicks, 1)
})
