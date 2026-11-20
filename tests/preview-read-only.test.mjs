// Issue #46: opening the live preview pushed the conversation's sidebar browser panel to the front.
//
// The chain was `capturePassive` → CDP → the host's guest lookup → the bridge's `ensureSidebar` →
// a retry that asks the client half to `openSession`. For a tool call that is deliberate (the agent's
// page should be in front of the human). For a preview it is a read-only action changing the
// reader's layout, which is the reported bug.
//
// Two properties are pinned here: the preview's command is marked as non-presenting, and the host
// honours that mark by taking a read-only lookup instead of the presenting path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserPanelNotDisplayedError, DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'

/** A host whose single view records the options each command was sent with. */
function makeHost() {
  const sent = []
  const view = {
    id: 'view1',
    async sendCommand(method, params, options) {
      sent.push({ method, params, options })
      if (method === 'Runtime.evaluate') {
        const expression = params?.expression ?? ''
        if (expression.includes('timeOrigin')) return { result: { value: '1|complete' } }
        if (expression.includes('document.title')) return { result: { value: 'about:blank\u0000Example' } }
        return { result: { value: { ok: true } } }
      }
      // Page.captureScreenshot — the preview path.
      return { data: Buffer.from('frame').toString('base64') }
    },
    // Deliberately NO `capture`: this models the sidebar / installed-Chrome carrier, whose encoding
    // happens through CDP. A view with `capture` takes the self-hosted NativeImage path, which is a
    // different branch of capturePassive and not what this test is about.
  }
  return {
    sent,
    createView() { return view },
    destroyView() {},
    groupView() {},
    onUserAction() {},
    showView() {},
    async presentView() {},
  }
}

test('a preview capture is marked as non-presenting', async () => {
  const host = makeHost()
  const provider = new ElectronBrowserProvider(host, { settings: () => DEFAULT_SETTINGS })
  const session = await provider.open()
  host.sent.length = 0

  await provider.capturePassive(session)

  const shot = host.sent.find(entry => entry.method === 'Page.captureScreenshot')
  assert.ok(shot !== undefined, 'the preview captures through CDP')
  assert.equal(shot.options?.present, false,
    'and says it must not present: that flag is what keeps the sidebar panel where the reader left it')
})

test('an ordinary tool command still presents', async () => {
  // The flag is opt-in per command, never a change to the default: a tool call that opens a page must
  // still bring it to the human's attention.
  const host = makeHost()
  const provider = new ElectronBrowserProvider(host, { settings: () => DEFAULT_SETTINGS })
  const session = await provider.open()
  host.sent.length = 0
  await provider.capturePassive(session)
  const preview = host.sent.find(entry => entry.method === 'Page.captureScreenshot')
  assert.equal(preview.options?.present, false)

  host.sent.length = 0
  await provider.screenshot(session)
  const tool = host.sent.find(entry => entry.method === 'Page.captureScreenshot')
  assert.equal(tool.options, undefined, 'a screenshot the agent asked for is not read-only')
})

/** A fake bridge that records every op and answers `list` from `answers.sidebar`. */
async function startFakeBridge(answers = {}) {
  const requests = []
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let authed = false
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        const request = JSON.parse(line)
        if (!authed) {
          if (request.token !== 'test-token') { socket.destroy(); return }
          authed = true
          if (typeof request.op !== 'string' || request.op === '') continue
        }
        requests.push(request)
        const answer = (() => {
          if (request.op === 'list') {
            const sidebar = answers.sidebar ?? []
            return { ok: true, guests: sidebar, sidebar, frame: 'webview' }
          }
          if (request.op === 'ensureSidebar') {
            // Reaching here for a preview is the bug: this op can drive the shell.
            return { ok: true, id: 7, created: false }
          }
          if (request.op === 'cdp') return { ok: true, result: { data: 'AAAA' } }
          return { ok: false, error: `unknown op ${String(request.op)}` }
        })()
        socket.write(JSON.stringify(answer) + '\n')
      }
    })
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    port,
    requests,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** Point DSH_HOME at a throwaway dir holding an endpoint file. */
function withEndpoint(port) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-preview-'))
  writeFileSync(join(home, 'dsh-builtin-browser.json'), JSON.stringify({ port, token: 'test-token', pid: process.pid }))
  process.env.DSH_HOME = home
  return home
}

test('a non-presenting command reads the page list instead of asking the shell to present', async () => {
  // `list` is a pure read on EVERY bridge version, including the pre-#37 ones that drove the sidebar
  // like a human when asked to ensure it. That is what makes the preview safe on an old install.
  const bridge = await startFakeBridge({ sidebar: [{ id: 9, type: 'webview', url: 'https://example.com/', title: 'E' }] })
  writeFileSync(join(withEndpoint(bridge.port), 'dsh-builtin-browser-bridge.json'),
    JSON.stringify({ port: bridge.port, token: 'test-token', pid: process.pid }))
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    assert.ok(host !== undefined, 'the bridge is discovered')
    // `discover` itself reads the list once (owner-less liveness probe); count only what follows.
    const baseline = bridge.requests.filter(request => request.op === 'list').length
    const view = host.createView('session-a')
    const result = await view.sendCommand('Page.captureScreenshot', { format: 'jpeg' }, { present: false })
    assert.deepEqual(result, { data: 'AAAA' }, 'the command reached the page')

    const lookups = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(lookups.length, 0, 'the presenting op is never sent for a read-only command')
    const listed = bridge.requests.filter(request => request.op === 'list')
    assert.equal(listed.length - baseline, 1, 'one extra read of the page list instead')
    assert.equal(listed.at(-1).owner, 'session-a', 'scoped to the conversation that asked')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('a conversation with no attached page reports as a display state, without presenting it', async () => {
  const bridge = await startFakeBridge({ sidebar: [] })
  writeFileSync(join(withEndpoint(bridge.port), 'dsh-builtin-browser-bridge.json'),
    JSON.stringify({ port: bridge.port, token: 'test-token', pid: process.pid }))
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    assert.ok(host !== undefined)
    const view = host.createView('session-a')
    await assert.rejects(
      view.sendCommand('Page.captureScreenshot', {}, { present: false }),
      error => {
        assert.ok(error instanceof BrowserPanelNotDisplayedError,
          `expected a display state, got ${error?.name}: ${error?.message}`)
        return true
      },
    )
    const lookups = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(lookups.length, 0, 'nothing was presented, and no retry loop ran')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})
