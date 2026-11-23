/**
 * DSH Tauri renders its shell in an electron-rs WebContentsView, not a BrowserWindow, so a bridge that
 * looks for the `window` webContents finds no shell there. The host patch names the shell view through
 * `api.shellContents`, and every shell-side read goes through it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { connect } from 'node:net'

function call(endpoint, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.port, '127.0.0.1')
    let pending = ''
    socket.on('error', reject)
    socket.on('data', chunk => {
      pending += chunk
      const index = pending.indexOf('\n')
      if (index >= 0) { socket.destroy(); resolve(JSON.parse(pending.slice(0, index))) }
    })
    socket.write(JSON.stringify({ token: endpoint.token, ...request }) + '\n')
  })
}

async function bridgeWith(t, api) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-tauri-shell-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const shell = { id: 1, getType: () => 'browserView', isDestroyed: () => false,
    executeJavaScript: expression => runInNewContext(expression, {
      globalThis: { __dshBuiltinBrowser: { panelProtocol: 5, panelGuests: () => [] } },
      document: { querySelector: () => ({ getAttribute: () => 'webview' }) },
    }) }
  globalThis.__tauriShellElectron = { app: new EventEmitter(), webContents: { getAllWebContents: () => [shell], fromId: id => id === 1 ? shell : undefined } }
  const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
    .replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__tauriShellElectron')
  writeFileSync(join(directory, 'bridge.mjs'), source)
  for (const name of ['guest-proxy.mjs', 'native-guests.mjs']) writeFileSync(join(directory, name), readFileSync(new URL(`../desktop-bridge/${name}`, import.meta.url)))
  const bridge = await import(pathToFileURL(join(directory, 'bridge.mjs')))
  const server = bridge.start(api === undefined ? undefined : api(shell))
  await once(server, 'listening')
  const endpoint = JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8'))
  const wire = { call: request => call(endpoint, request) }
  t.after(() => {
    bridge.stop()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete globalThis.__tauriShellElectron
    rmSync(directory, { recursive: true, force: true })
  })
  return wire
}

test('a shell rendered in a view is invisible to the bridge unless the host names it (the Tauri bug)', async t => {
  const wire = await bridgeWith(t)
  assert.equal((await wire.call({ op: 'list' })).frame, 'unknown')
})

test('the bridge reads the sidebar from the shell view the host names', async t => {
  const wire = await bridgeWith(t, shell => ({ shellContents: () => shell }))
  const answer = await wire.call({ op: 'list' })
  assert.equal(answer.ok, true)
  assert.equal(answer.frame, 'webview')
})
