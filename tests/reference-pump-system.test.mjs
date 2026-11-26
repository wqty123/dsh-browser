// Issue #105: the reference overlay pump on SystemBrowserViewHost must never recreate
// tabs that the user closed as about:blank, and must never relaunch a killed browser.
// Also verifies that a stale CDP session on a still-live target reattaches to that
// original target instead of spawning a blank replacement tab.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 900105
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    if (child.exitCode !== null) return true
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return child
}

function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  for (;;) {
    if (offset + 2 > buffer.length) break
    const length = buffer[offset + 1] & 0x7f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let start = offset + 2
    let payloadLength = length
    if (length === 126) {
      if (start + 2 > buffer.length) break
      payloadLength = buffer.readUInt16BE(start)
      start += 2
    } else if (length === 127) {
      if (start + 8 > buffer.length) break
      payloadLength = Number(buffer.readBigUInt64BE(start))
      start += 8
    }
    const mask = masked ? buffer.subarray(start, start + 4) : undefined
    if (masked) start += 4
    if (start + payloadLength > buffer.length) break
    const payload = buffer.subarray(start, start + payloadLength)
    if (mask !== undefined) {
      const unmasked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4]
      frames.push(unmasked.toString('utf8'))
    } else {
      frames.push(payload.toString('utf8'))
    }
    offset = start + payloadLength
  }
  return { frames, rest: buffer.subarray(offset) }
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

/** Minimal CDP browser whose tabs can be closed by the user independently of the plugin. */
function createClosableBrowser() {
  const liveTargets = new Set()
  const created = []
  const attachedTargets = []
  const sessionToTarget = new Map()
  const sockets = new Set()

  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        Browser: 'Chrome/156.0.0.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser`,
      }))
      return
    }
    response.writeHead(404)
    response.end()
  })

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffered = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const { frames, rest } = decodeFrames(buffered)
      buffered = rest
      for (const frame of frames) {
        let message
        try { message = JSON.parse(frame) } catch { continue }
        const reply = handle(message)
        if (reply !== undefined) socket.write(encodeFrame(JSON.stringify(reply)))
      }
    })
  })

  function handle(message) {
    if (message.id === undefined) return undefined
    const { id, method, params, sessionId } = message
    if (method === 'Browser.getVersion') return { id, result: { product: 'Chrome/156.0.0.0', userAgent: 'Chrome/156.0.0.0' } }
    if (method === 'Target.setDiscoverTargets') return { id, result: {} }
    if (method === 'Target.getTargets') {
      return {
        id,
        result: { targetInfos: [...liveTargets].map(targetId => ({ targetId, type: 'page', url: 'https://example.test/' })) },
      }
    }
    if (method === 'Target.createTarget') {
      const targetId = `target-${randomUUID()}`
      liveTargets.add(targetId)
      created.push(targetId)
      return { id, result: { targetId } }
    }
    if (method === 'Target.attachToTarget') {
      const targetId = params?.targetId
      if (!liveTargets.has(targetId)) return { id, error: { message: 'No target with given id found' } }
      const sid = `session-${randomUUID()}`
      sessionToTarget.set(sid, targetId)
      attachedTargets.push(targetId)
      return { id, result: { sessionId: sid } }
    }
    if (sessionId !== undefined) {
      const targetId = sessionToTarget.get(sessionId)
      if (targetId === undefined || !liveTargets.has(targetId)) {
        return { id, sessionId, error: { message: 'Session with given id not found.' } }
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '')
        if (expr.includes('__dshRefOverlayInstalled')) return { id, sessionId, result: { result: { value: null } } }
        return { id, sessionId, result: { result: { value: `ok:${targetId}` } } }
      }
    }
    return { id, sessionId, result: {} }
  }

  return {
    get created() { return [...created] },
    get liveTargets() { return [...liveTargets] },
    get attachedTargets() { return [...attachedTargets] },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    /** Expire all CDP sessions for a still-alive target (simulates renderer/attach swap). */
    expireSessions(targetId) {
      for (const [sid, tid] of sessionToTarget) {
        if (tid === targetId) sessionToTarget.delete(sid)
      }
    },
    /** Simulate the user closing a tab in Chrome/Edge. */
    closeTargetByUser(targetId, { emitDestroyed = true } = {}) {
      liveTargets.delete(targetId)
      for (const [sid, tid] of sessionToTarget) {
        if (tid === targetId) sessionToTarget.delete(sid)
      }
      if (emitDestroyed) {
        const event = encodeFrame(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId } }))
        for (const socket of sockets) socket.write(event)
      }
    },
    async kill() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

for (const emitDestroyed of [true, false]) {
  test(`reference pump does not recreate a user-closed tab (emitDestroyed=${emitDestroyed})`, async t => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-issue105-tab-'))
    const browser = createClosableBrowser()
    const port = await browser.listen()
    let launches = 0
    const children = []
    const host = new SystemBrowserViewHost(
      { kind: 'edge', path: process.execPath },
      profileDir,
      [],
      undefined,
      () => {
        launches += 1
        const portFile = join(profileDir, 'DevToolsActivePort')
        writeFileSync(portFile, `${port}\n`)
        const ahead = new Date(Date.now() + 1000)
        utimesSync(portFile, ahead, ahead)
        const child = fakeChild()
        children.push(child)
        return child
      },
      'auto',
      () => false,
      undefined,
      { managed: true },
    )
    const provider = new ElectronBrowserProvider(host, {
      history: { enabled: false },
      referenceLabel: () => 'agent-105',
    })
    provider.stopReferenceEntryPump()
    t.after(async () => {
      provider.dispose()
      host.dispose()
      for (const child of children) { child.exitCode = 0 }
      await browser.kill()
      rmSync(profileDir, { recursive: true, force: true })
    })

    const sessionId = await provider.open('agent-105')
    const tab = provider.sessions.get(sessionId).tabs[0]
    await tab.handle.sendCommand('Runtime.evaluate', { expression: '1' })
    assert.equal(browser.created.length, 1)
    assert.equal(launches, 1)

    // User closes the tab in Edge.
    browser.closeTargetByUser(browser.created[0], { emitDestroyed })
    if (emitDestroyed) await new Promise(resolve => setTimeout(resolve, 30))

    // Multiple reference-pump ticks must neither recreate about:blank nor spawn a new browser.
    for (let i = 0; i < 4; i += 1) {
      await provider.pumpReferenceEntry()
    }
    assert.equal(browser.created.length, 1, 'reference pump must not recreate a closed tab as about:blank')
    assert.equal(browser.liveTargets.length, 0, 'closed tab stays closed')
    assert.equal(launches, 1)

    // Even a direct command on the stale session fails rather than silently spawning a blank page,
    // when the target is gone before the view cache was cleared.
    if (!emitDestroyed) {
      const second = await provider.open('agent-105')
      const secondTab = provider.sessions.get(second).tabs[0]
      await secondTab.handle.sendCommand('Runtime.evaluate', { expression: '1' })
      assert.equal(browser.created.length, 2)
      browser.closeTargetByUser(browser.created[1], { emitDestroyed: false })
      await assert.rejects(
        () => secondTab.handle.sendCommand('Runtime.evaluate', { expression: '2' }),
        /Session with given id not found/i,
      )
      assert.equal(browser.created.length, 2, 'sendWithAttach must not create about:blank for a destroyed target')
    }
  })
}

test('stale CDP session on a still-alive target reattaches to the original page without creating about:blank', async t => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-reattach-live-'))
  const browser = createClosableBrowser()
  const port = await browser.listen()
  const children = []
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: process.execPath },
    profileDir,
    [],
    undefined,
    () => {
      const portFile = join(profileDir, 'DevToolsActivePort')
      writeFileSync(portFile, `${port}\n`)
      const ahead = new Date(Date.now() + 1000)
      utimesSync(portFile, ahead, ahead)
      const child = fakeChild()
      children.push(child)
      return child
    },
    'auto',
    () => false,
    undefined,
    { managed: true },
  )
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  provider.stopReferenceEntryPump()
  t.after(async () => {
    provider.dispose()
    host.dispose()
    for (const child of children) { child.exitCode = 0 }
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  })

  const sessionId = await provider.open('agent-reattach')
  const tab = provider.sessions.get(sessionId).tabs[0]
  const first = await tab.handle.sendCommand('Runtime.evaluate', { expression: '1' })
  assert.equal(browser.created.length, 1)
  const originalTarget = browser.created[0]
  assert.equal(first.result.value, `ok:${originalTarget}`)

  // Expire the CDP session id while the page target remains alive (e.g. renderer swap on form POST).
  browser.expireSessions(originalTarget)

  const [retriedA, retriedB] = await Promise.all([
    tab.handle.sendCommand('Runtime.evaluate', { expression: '2' }),
    tab.handle.sendCommand('Runtime.evaluate', { expression: '3' }),
  ])
  assert.equal(browser.created.length, 1, 'must not spawn a replacement about:blank target')
  assert.equal(browser.liveTargets.length, 1, 'only the original target exists')
  assert.equal(retriedA.result.value, `ok:${originalTarget}`, 'command runs on the original target')
  assert.equal(retriedB.result.value, `ok:${originalTarget}`, 'concurrent command shares the reattached target')
  assert.deepEqual(browser.attachedTargets, [originalTarget, originalTarget], 'reattached exactly once to the original target')
})

test('reference pump does not relaunch a browser after the user kills its process', async t => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-issue105-kill-'))
  const browser = createClosableBrowser()
  const port = await browser.listen()
  let launches = 0
  const children = []
  const host = new SystemBrowserViewHost(
    { kind: 'edge', path: process.execPath },
    profileDir,
    [],
    undefined,
    () => {
      launches += 1
      const portFile = join(profileDir, 'DevToolsActivePort')
      writeFileSync(portFile, `${port}\n`)
      const ahead = new Date(Date.now() + 1000)
      utimesSync(portFile, ahead, ahead)
      const child = fakeChild()
      children.push(child)
      return child
    },
    'auto',
    () => false,
    undefined,
    { managed: true },
  )
  const provider = new ElectronBrowserProvider(host, {
    history: { enabled: false },
    referenceLabel: () => 'agent-105',
  })
  provider.stopReferenceEntryPump()
  t.after(async () => {
    provider.dispose()
    host.dispose()
    for (const child of children) { child.exitCode = 0 }
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  })

  const sessionId = await provider.open('agent-105')
  const tab = provider.sessions.get(sessionId).tabs[0]
  await tab.handle.sendCommand('Runtime.evaluate', { expression: '1' })
  assert.equal(launches, 1)

  // User kills the browser process.
  await browser.kill()
  children[0].exitCode = 0
  children[0].emit('exit', 0, null)

  // Multiple reference-pump ticks must not restart the browser.
  for (let i = 0; i < 4; i += 1) {
    await provider.pumpReferenceEntry()
  }
  assert.equal(launches, 1, 'reference pump must never relaunch a killed browser')
})
