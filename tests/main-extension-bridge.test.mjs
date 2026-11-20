import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect } from 'node:net'
import { BridgeConnection } from '../src/browser-electron/bridge-connection.ts'
import { extensionHomeId } from '../src/browser-electron/profile-extension.ts'

test('main extension starts once, reports host status, replaces a crash endpoint and closes sockets/listeners/endpoints on quit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'main-extension-bridge-'))
  t.after(() => { delete globalThis.__extensionElectron; rmSync(root, { recursive: true, force: true }) })
  const directory = join(root, 'desktop-bridge'), home = join(root, 'home')
  mkdirSync(directory); mkdirSync(home)
  const endpointPath = join(home, 'dsh-builtin-browser-bridge.json')
  writeFileSync(endpointPath, JSON.stringify({ pid: 999999999, port: 1, token: 'crash-token' }))
  const app = new EventEmitter(), webContents = { getAllWebContents: () => [] }
  globalThis.__extensionElectron = { app, webContents }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-builtin-browser', version: '0.7.42', type: 'module' }))
  for (const name of ['main.mjs', 'guest-proxy.mjs', 'plugin-browser-bridge.js']) {
    const source = readFileSync(new URL(`../desktop-bridge/${name}`, import.meta.url), 'utf8')
      .replace("import { app, webContents } from 'electron'", 'const { app, webContents } = globalThis.__extensionElectron')
    writeFileSync(join(directory, name), source)
  }
  const main = await import(pathToFileURL(join(directory, 'main.mjs')).href)
  const bridge = await import(pathToFileURL(join(directory, 'plugin-browser-bridge.js')).href)
  const status = { state: 'loaded', version: '0.7.42', loadedAt: new Date().toISOString() }
  const api = { app, webContents, mainWindow: () => undefined, dshHome: home,
    mainExtensions: { async status(name) { assert.equal(name, 'dsh-builtin-browser'); return status } } }
  const dispose = main.start(api)
  t.after(() => dispose())
  const server = bridge.start(api)
  assert.equal(bridge.start(api), server)
  if (!server.listening) await once(server, 'listening')
  assert.equal(app.listenerCount('will-quit'), 1)
  assert.equal(app.listenerCount('web-contents-created'), 1)
  const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'))
  assert.equal(endpoint.pid, process.pid); assert.notEqual(endpoint.token, 'crash-token')
  const connection = new BridgeConnection(endpoint)
  t.after(() => connection.close())
  const version = await connection.call({ op: 'version' }, 1_000)
  assert.deepEqual(version.mainExtension, status)
  assert.equal(version.bridgeVersion, '0.7.42'); assert.match(version.bridgeBuild, /^[a-f0-9]{64}$/)
  assert.equal(version.homeId, extensionHomeId(home))
  assert.equal('dshHome' in version, false)
  const socket = connect(endpoint.port, '127.0.0.1')
  await once(socket, 'connect')
  const closed = once(socket, 'close'), stopped = once(server, 'close')
  app.emit('will-quit')
  await Promise.all([closed, stopped])
  assert.equal(server.listening, false)
  assert.equal(app.listenerCount('will-quit'), 0); assert.equal(app.listenerCount('web-contents-created'), 0)
  assert.equal(existsSync(endpointPath), false)
  dispose()
})
