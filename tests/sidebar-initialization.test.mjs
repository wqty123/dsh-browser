import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.ISSUE47_PACKAGE_ROOT
const load = path => root ? import(pathToFileURL(join(root, 'lib', path))) : import(new URL('../lib/' + path, import.meta.url))
const { DesktopBridgeViewHost, BrowserPanelNotDisplayedError } = await load('browser-electron/desktop-bridge-host.js')
const { ElectronBrowserProvider } = await load('browser-electron/provider.js')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function peer({ oldDelay = 4200, navigationDelay = 2500, ready = true } = {}) {
  const requests = []
  const sockets = new Set()
  const timers = new Set()
  const state = { ready }
  const later = (ms, value) => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(value) }, ms)
    timers.add(timer)
  })
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', chunk => {
      buffer += String(chunk)
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line)
        if (request.token && !request.op) continue
        requests.push({ ...request, at: Date.now() })
        const reply = async () => {
          if (request.op === 'list') return { ok: true, guests: [], sidebar: [] }
          if (request.op === 'ensureSidebar') {
            if (!request.url) return await later(oldDelay, { ok: false, error: "this conversation's browser panel produced no page within its budget" })
            await later(navigationDelay, null)
            return state.ready
              ? { ok: true, id: 7 }
              : { ok: false, code: 'panel-initializing', error: "this conversation's browser panel produced no page within its budget" }
          }
          if (request.op === 'cdp') return { ok: true, result: request.method === 'Runtime.evaluate'
            ? { result: { value: 'late-document|complete' } } : {} }
          return { ok: true }
        }
        void reply().then(value => {
          if (!socket.destroyed) socket.write(JSON.stringify({ ...value, bridgeRequestId: request.bridgeRequestId }) + '\n')
        })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const home = mkdtempSync(join(tmpdir(), 'issue47-'))
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'dsh-builtin-browser-bridge.json'), JSON.stringify({ port: server.address().port, token: 'isolated-issue47', pid: process.pid }))
  const host = await DesktopBridgeViewHost.discover('session-issue47')
  assert.ok(host)
  return {
    host, state, requests,
    async close() {
      host.dispose()
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test('first navigation uses one URL initialization and its probe never initializes the sidebar', async () => {
  const bridge = await peer({ navigationDelay: 100 })
  const losses = []
  bridge.host.onLost(reason => { losses.push(reason); setImmediate(() => bridge.host.dispose()) })
  try {
    const provider = new ElectronBrowserProvider(bridge.host, { history: { enabled: false } })
    const session = await provider.open('session-issue47')
    await provider.openUrl(session, { url: 'https://example.com/' })
    const initialization = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(initialization.length, 1)
    assert.equal(initialization[0].url, 'https://example.com/')
    assert.deepEqual(losses, [])
  } finally { await bridge.close() }
})

test('an abandoned 3s probe failure at 4.2s cannot close the following URL navigation', async () => {
  const bridge = await peer()
  const losses = []
  bridge.host.onLost(reason => { losses.push(reason); setImmediate(() => bridge.host.dispose()) })
  try {
    const view = bridge.host.createView('session-issue47')
    // Reproduce the old caller leaving a 4s initialization request in flight after a 3s budget.
    const stale = view.sendCommand('Runtime.evaluate', { expression: '1' }).then(
      () => null,
      error => error,
    )
    await pause(3000)
    const navigated = await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.deepEqual(navigated, {})
    const error = await stale
    assert.ok(error instanceof BrowserPanelNotDisplayedError)
    assert.equal(error.code, 'panel-initializing')
    assert.match(error.message, /produced no page/)
    assert.deepEqual(losses, [])
    const reading = await view.sendCommand('Runtime.evaluate', { expression: 'document.readyState' })
    assert.equal(reading.result.value, 'late-document|complete')
  } finally { await bridge.close() }
})

test('initialization budget failure stays recoverable on the same host when the guest attaches later', async () => {
  const bridge = await peer({ navigationDelay: 5, ready: false })
  const losses = []
  bridge.host.onLost(reason => losses.push(reason))
  try {
    const view = bridge.host.createView('session-issue47')
    await assert.rejects(
      view.sendCommand('Page.navigate', { url: 'https://example.com/' }),
      error => error instanceof BrowserPanelNotDisplayedError && error.code === 'panel-initializing',
    )
    bridge.state.ready = true
    await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.deepEqual(losses, [])
  } finally { await bridge.close() }
})
