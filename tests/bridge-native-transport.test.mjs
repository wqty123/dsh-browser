import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'
import { sessionWireId, tabWireId } from '../lib/browser/handles.js'

test('native TCP bridge requires committed acknowledgement, retains holds and dispatches only through scoped guest capabilities', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-transport-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const owner = 'session-native', lease = 'native-lease'
  const scope = tabWireId({ owner, session: 'sidebar', tab: 'native-ui' })
  const handle = tabWireId({ owner, session: 'browser', tab: 'native-tool' })
  const session = sessionWireId({ owner, session: 'browser' })
  const state = { stage: 'document', generation: 'generation', frameId: 'frame', loaderId: 'loader' }
  const calls = [], released = [], holds = new Set()
  let alive = true, acknowledged = false
  const capability = {
    protocolVersion: 1,
    snapshot: () => alive ? [{ scope, lease, state, url: 'https://native.example/', title: 'Native' }] : [],
    command: async (...args) => { calls.push(args); return { result: { value: 'native document' } } },
    release: async (...args) => { released.push(args); alive = false },
  }
  const api = {
    panelProtocol: 5,
    holdRendering: (_owner, token) => { holds.add(token); return true },
    releaseRendering: token => holds.delete(token),
    isBackgroundRendering: () => true,
    initializePanel: async () => ({ ok: true, panel: true, displayed: false, guestId: lease,
      nativeState: { guestId: lease, ...state, generation: acknowledged ? state.generation : 'uncommitted' } }),
  }
  const shell = { id: 1, getType: () => 'window', isDestroyed: () => false,
    executeJavaScript: expression => runInNewContext(expression, { globalThis: { __dshBuiltinBrowser: api } }) }
  globalThis.__nativeTransportElectron = { app: new EventEmitter(), webContents: {
    getAllWebContents: () => [shell], fromId: id => id === 1 ? shell : undefined,
  } }
  const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
    .replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__nativeTransportElectron')
  writeFileSync(join(directory, 'bridge.mjs'), source)
  for (const file of ['guest-proxy.mjs', 'native-guests.mjs']) {
    writeFileSync(join(directory, file), readFileSync(new URL('../desktop-bridge/' + file, import.meta.url)))
  }
  const bridge = await import(pathToFileURL(join(directory, 'bridge.mjs')))
  const server = bridge.start({ browserGuests: capability })
  let wire
  t.after(async () => {
    wire?.close(); bridge.stop()
    await new Promise(resolve => setImmediate(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete globalThis.__nativeTransportElectron
    rmSync(directory, { recursive: true, force: true })
  })
  await once(server, 'listening')
  wire = new BridgeConnection(JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8')))
  assert.equal((await wire.call({ op: 'list' })).frame, 'native')
  const ensure = () => wire.call({ op: 'ensureSidebar', handle, url: '', deadline: Date.now() + 2000, transactionId: 'native-init' })
  assert.equal((await ensure()).code, 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
  assert.equal(calls.length, 0)
  assert.equal(holds.size, 0)
  acknowledged = true
  assert.equal((await ensure()).ok, true)
  assert.equal(holds.size, 0)
  const answer = await wire.call({ op: 'cdp', handle, method: 'Runtime.evaluate', params: { expression: 'document.title' } })
  assert.equal(answer.result.result.value, 'native document')
  assert.deepEqual(calls.at(-1), [scope, lease, 'Runtime.evaluate', { expression: 'document.title' }])
  const cookies = [{ name: 'login', value: 'restored', domain: 'native.example', path: '/' }]
  assert.equal((await wire.call({ op: 'cdp', handle, method: 'Storage.setCookies', params: { cookies } })).ok, true)
  assert.deepEqual(calls.at(-1), [scope, lease, 'Storage.setCookies', { cookies }])
  const foreign = sessionWireId({ owner: 'session-foreign', session: 'browser' })
  assert.deepEqual((await wire.call({ op: 'list', handle: foreign })).sidebar, [])
  assert.equal((await wire.call({ op: 'list', handle: session })).sidebar.length, 1)
  bridge.stop()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(released, [[scope, lease]])
  assert.equal(holds.size, 0)
})
