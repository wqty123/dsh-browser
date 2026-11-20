import { testTab, testScope, tabIn } from './canonical-fixtures.mjs'
import { resolveSessionHandle, sessionWireId, tabWireId, readTabHandle } from '../lib/browser/handles.js'
// The desktop sidebar host talks to the shell over a loopback bridge. These tests
// stand up a fake bridge (same protocol) so the host's behaviour is pinned without
// a desktop app: discovery rejects dead endpoints, commands are forwarded, each
// view takes its own tab, and a tab the human closed fails without replacement.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { typescriptSourceLoader } from './typescript-source.mjs'

const loader = typescriptSourceLoader()
const { BrowserPanelNotDisplayedError, DesktopBridgeViewHost } = await import('../src/browser-electron/desktop-bridge-host.ts')
loader.deregister()

/** A fake shell bridge: records requests, answers with scripted state. */
async function startFakeBridge(state = { tabs: 1, dead: [] }) {
  const requests = []
  const sockets = new Set()
  const views = new Map()
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
          if (request.token !== 'test-token') { socket.write(JSON.stringify({ ok: false, error: 'bad token' }) + '\n'); socket.destroy(); return }
          authed = true
          // The authenticating message is not a command and gets NO answer: the real
          // bridge ignores it, and replying here would let that stray reply be
          // consumed as the answer to the next request.
          if (typeof request.op !== 'string' || request.op === '') continue
        }
        requests.push(request)
        const answer = (() => {
          if (request.op === 'list') {
            if (state.listAnswer) return state.listAnswer
            const sidebar = []
            for (let i = 1; i <= state.tabs; i++) {
              if (state.dead.includes(i)) continue
              const id = [...views].find(([, guest]) => guest === i)?.[0]
                ?? (request.handle ? tabWireId({ ...resolveSessionHandle(request.handle), tab: `page:${i}` }) : undefined)
              if (id) sidebar.push({ id, type: 'webview', url: `https://page${i}.example/`, title: `Page ${i}`, destroyed: false })
            }
            return { ok: true, sidebar, protocol: state.protocol ?? 4 }
          }
          if (request.op === 'ensureSidebar') {
            // The real op answers with the page THIS conversation's panel holds, and that page
            // changes when the human closes its tab. Returning a fixed id made the recovery path
            // untestable: the host would be handed the id it had just proven dead.
            //
            // `panelNotDisplayed` reproduces issue #37: the panel exists, the shell is showing a
            // different conversation, so no webview has attached. The real bridge reports that with
            // a code, and the plugin must treat it as a display state rather than a dead carrier.
            if (state.panelUncodedLeft > 0) {
              // What a bridge installed BEFORE issue #37 answers: the same refusal, with no code.
              // Measured on this machine — the installed copy has no `panel-not-displayed` in it —
              // so classifying by the code alone failed exactly the users who never reinstalled.
              state.panelUncodedLeft -= 1
              return {
                ok: false,
                error: 'a panel was placed in this conversation\'s sidebar, but its page can only '
                  + 'attach while the conversation is the one displayed — show it and the page appears',
              }
            }
            if (state.panelNotDisplayedLeft > 0) {
              // The shape a just-switched conversation produces: the shell has been asked to show
              // it, the render has not happened yet, so this refusal is true and already stale.
              state.panelNotDisplayedLeft -= 1
              return {
                ok: false,
                code: 'panel-not-displayed',
                error: 'a panel was placed in this conversation\'s sidebar, but its page can only '
                  + 'attach while the conversation is the one displayed — show it and the page appears',
              }
            }
            if (state.panelNotDisplayed === true) {
              return {
                ok: false,
                code: 'panel-not-displayed',
                error: 'a panel was placed in this conversation\'s sidebar, but its page can only '
                  + 'attach while the conversation is the one displayed — show it and the page appears',
              }
            }
            if (state.panelUnusable === true) {
              return { ok: false, code: 'panel-unusable', error: state.panelUnusableDetail ?? 'the sidebar has no drivable webview capability' }
            }
            {
              const key = request.handle
              let id = views.get(key)
              if (id === undefined || state.dead.includes(id)) {
                id = 1
                while (state.dead.includes(id) || [...views.values()].includes(id)) id += 1
                views.set(key, id)
                state.tabs = Math.max(state.tabs, id)
              }
              return { ok: true, id: request.handle, via: 'panel' }
            }
          }
          if (request.op === 'cancelSidebar') return { ok: true, cancelled: true }
          if (request.op === 'cdp') {
            if (state.cdpAnswer) return state.cdpAnswer
            // A closed tab makes the real bridge answer exactly like this; the host
            // must treat it as "the page is gone", not as a command failure.
            const id = views.get(request.handle)
            if (state.dead.includes(id)) return { ok: false, code: 'BROWSER_HANDLE_STALE', error: `guest ${id} is not available` }
            return { ok: true, result: { echo: request.method, guest: id } }
          }
          if (request.op === 'closeSidebarBrowser') return { ok: true, closed: state.tabs }
          if (request.op === 'closePage') return { ok: true, closed: state.closeCount ?? 1 }
          if (request.op === 'releaseSession') return state.refuseRelease
            ? { ok: false, error: 'fixture release refused' } : { ok: true }
          if (request.op === 'releaseTab') return { ok: true }
          if (request.op === 'showTab') return { ok: true, verdict: 'SELECTED' }
          if (request.op === 'collapseSidebar') return { ok: true, result: 'COLLAPSED' }
          return { ok: false, error: `unknown op ${String(request.op)}` }
        })()
        const respond = () => socket.write(JSON.stringify({ ...answer, bridgeRequestId: request.bridgeRequestId }) + '\n')
        if (request.op === 'ensureSidebar' && state.holdEnsure === true) {
          ;(state.heldReplies ??= []).push(respond)
        } else respond()
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
    state,
    // Destroy live connections too: `server.close()` alone only stops listening,
    // and a lingering socket keeps the test runner's event loop alive. The promise
    // resolves only once the listener is really gone, so a caller that awaits it
    // is not left pending (which is how the rest of the file got cancelled).
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** Point DSH_HOME at a throwaway dir holding an endpoint file. */
function withEndpoint(port, { token = 'test-token' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-'))
  writeFileSync(join(home, 'dsh-builtin-browser-bridge.json'), JSON.stringify({ port, token, pid: process.pid }))
  process.env.DSH_HOME = home
  return home
}

test('discovery fails safe when there is no bridge at all', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-none-'))
  process.env.DSH_HOME = home
  assert.equal(await DesktopBridgeViewHost.discover(), undefined, 'no endpoint file -> self-host')
})

test('discovery rejects an endpoint whose listener is gone', async () => {
  // A shell that exited leaves its endpoint file behind; connecting must fail and
  // the caller must fall back rather than adopt a dead carrier.
  const { port, close } = await startFakeBridge()
  await close()
  withEndpoint(port)
  assert.equal(await DesktopBridgeViewHost.discover(), undefined, 'dead endpoint -> self-host')
})

test('commands are forwarded to the sidebar guest', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined, 'a live bridge is adopted')
    const view = host.createView(testTab())
    const answer = await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.equal(answer.echo, 'Page.navigate')
    assert.ok(bridge.requests.some(r => r.op === 'cdp' && r.method === 'Page.navigate'), 'the command reached the bridge')
  } finally {
    bridge.close()
  }
})

test('canonical handles keep independent native pages for non-navigating commands', async () => {
  // Protocol 2 cannot distinguish native tabs. Existing non-navigating handles stay usable while
  // a second URL navigation must request an updated bridge rather than overwrite their page.
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    const first = host.createView(testTab())
    await first.sendCommand('Runtime.evaluate', { expression: '1' })
    const second = host.createView(testTab())
    await second.sendCommand('Runtime.evaluate', { expression: '2' })

    const guestIds = bridge.requests.filter(r => r.op === 'cdp').map(r => r.handle)
    assert.equal(new Set(guestIds).size, 2, 'each view keeps its canonical identity')
    assert.ok(bridge.requests.some(r => r.op === 'ensureSidebar'), 'and each asked for its conversation page')
    assert.ok(!bridge.requests.some(r => r.op === 'ensureTabs'),
      'the strip is never grown to satisfy a second view: there is no second page to grow it for')
  } finally {
    bridge.close()
  }
})

test('a bound canonical handle does not repeat sidebar initialization', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [], protocol: 4 })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a', () => true)
    const view = host.createView(testTab('session-a'))
    await view.sendCommand('Page.navigate', { url: 'https://page.example/' })
    await view.sendCommand('Runtime.evaluate', { expression: 'location.href' })
    await view.sendCommand('Page.navigate', { url: 'https://next.example/' })
    const requests = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].guestId, undefined)
    assert.equal(requests[0].handle, view.id)
    assert.equal(requests[0].attachOnly, true)
    assert.ok(bridge.requests.filter(request => request.op === 'cdp').every(request => request.handle === view.id))
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('protocol 4 gives each logical view an independent guest and keeps it when URLs change', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [], protocol: 4 })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a', () => true)
    const first = host.createView(testTab('session-a'))
    const second = host.createView(testTab('session-a'))
    const firstResult = await first.sendCommand('Page.navigate', { url: 'https://same.example/' })
    const secondResult = await second.sendCommand('Page.navigate', { url: 'https://same.example/' })
    assert.notEqual(firstResult.guest, secondResult.guest, 'same URLs still mean separate native pages')
    const returned = await first.sendCommand('Page.navigate', { url: 'https://changed-first.example/' })
    assert.equal(returned.guest, firstResult.guest)
    const initializations = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.deepEqual(initializations.map(request => request.handle), [first.id, second.id])
    assert.deepEqual(initializations.map(request => readTabHandle(request.handle).owner), ['session-a', 'session-a'])
    assert.equal(initializations[0].guestId, undefined)
    assert.equal(initializations[1].guestId, undefined)
    assert.equal(bridge.requests.some(request => request.op === 'ensureTabs'), false)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('legacy or invalid protocols are refused before any view can drive a native page', async () => {
  for (const protocol of [3, 'invalid']) {
    const bridge = await startFakeBridge({ tabs: 1, dead: [], protocol })
    withEndpoint(bridge.port)
    let host
    try {
      await assert.rejects(DesktopBridgeViewHost.discover('session-a'), {
        name: 'BridgeVersionError', code: 'BROWSER_BRIDGE_VERSION_MISMATCH',
        message: '桥接版本过旧，请点击 卸载并重装',
      })
      assert.equal(DesktopBridgeViewHost.compatibilityError(), '桥接版本过旧，请点击 卸载并重装')
      assert.ok(bridge.requests.every(request => request.op === 'list'))
    } finally {
      host?.dispose()
      await bridge.close()
    }
  }
})

test('discovery version refusals and missing versions are explicit, while unrelated failures remain distinct', async () => {
  const state = { tabs: 1, dead: [], listAnswer: undefined }
  const bridge = await startFakeBridge(state)
  withEndpoint(bridge.port)
  try {
    for (const answer of [
      { ok: false, code: 'BROWSER_BRIDGE_PROTOCOL_MISMATCH' },
      { ok: false, error: 'unsupported protocol version' },
      { ok: false, error: 'bridge version mismatch' },
      { ok: true },
    ]) {
      state.listAnswer = answer
      await assert.rejects(DesktopBridgeViewHost.discover(), { code: 'BROWSER_BRIDGE_VERSION_MISMATCH' })
      assert.equal(DesktopBridgeViewHost.compatibilityError(), '桥接版本过旧，请点击 卸载并重装')
    }
    state.listAnswer = { ok: false, error: 'sidebar unavailable' }
    assert.equal(await DesktopBridgeViewHost.discover(), undefined)
    assert.equal(DesktopBridgeViewHost.compatibilityError(), undefined)
    state.listAnswer = undefined
    const host = await DesktopBridgeViewHost.discover()
    assert.ok(host)
    assert.equal(DesktopBridgeViewHost.compatibilityError(), undefined)
    host.dispose()
    assert.ok(bridge.requests.every(request => request.op === 'list'))
  } finally { await bridge.close() }
})

for (const [code, name, message, errorCode] of [
  ['DSH_BRIDGE_PACKAGE_UNAVAILABLE', 'BridgeVersionError', '浏览器桥接不可用，请点击 卸载并重装', 'BROWSER_BRIDGE_VERSION_MISMATCH'],
  ['BROWSER_BRIDGE_OUTDATED', 'BridgeVersionError', '桥接版本过旧，请点击 卸载并重装', 'BROWSER_BRIDGE_VERSION_MISMATCH'],
  ['BROWSER_NATIVE_SURFACE_UNAVAILABLE', 'NativeSurfaceUnavailableError', '浏览器桥接不可用（原生侧栏未就绪），请打开 Desktop 浏览器侧栏后重试', 'BROWSER_NATIVE_SURFACE_UNAVAILABLE'],
]) test(`${code} is an actionable error during discovery and native commands`, async () => {
  const unavailable = { ok: false, code, error: 'bridge refused' }
  const state = { tabs: 1, dead: [], listAnswer: unavailable, cdpAnswer: undefined }
  const bridge = await startFakeBridge(state)
  withEndpoint(bridge.port)
  let host
  const expected = { name, code: errorCode, message }
  try {
    await assert.rejects(DesktopBridgeViewHost.discover(), expected)
    assert.equal(DesktopBridgeViewHost.compatibilityError(), expected.message)
    assert.ok(bridge.requests.every(request => request.op === 'list'))
    state.listAnswer = undefined
    host = await DesktopBridgeViewHost.discover()
    assert.equal(DesktopBridgeViewHost.compatibilityError(), undefined)
    const view = host.createView(testTab())
    state.cdpAnswer = unavailable
    await assert.rejects(view.sendCommand('Runtime.evaluate', { expression: '1' }), expected)
    state.cdpAnswer = undefined
    assert.equal((await view.sendCommand('Runtime.evaluate', { expression: '1' })).echo, 'Runtime.evaluate')
  } finally { host?.dispose(); await bridge.close() }
})

test('a passive preview never assigns another live page to an unopened logical view', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [], protocol: 4 })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a', () => true)
    const view = host.createView(testTab('session-a'))
    const before = bridge.requests.length
    await assert.rejects(view.sendCommand('Page.captureScreenshot', {}, { present: false }), BrowserPanelNotDisplayedError)
    assert.equal(bridge.requests.length, before, 'an uninitialized view has no verified native identity to preview')
    const result = await view.sendCommand('Page.navigate', { url: 'https://requested.example/' })
    const ensured = bridge.requests.find(request => request.op === 'ensureSidebar')
    assert.equal(ensured.guestId, undefined, 'the failed preview did not poison the view cache')
    assert.equal(result.guest, 1)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('aborting initialization cancels exactly its transaction without publishing a late guest', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [], protocol: 4, holdEnsure: true })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const view = host.createView(testTab('session-a')), controller = new AbortController()
    const pending = view.sendCommand('Page.navigate', { url: 'https://pending.example/' }, { signal: controller.signal })
    const rejected = assert.rejects(pending, /cancelled by caller/)
    const deadline = Date.now() + 1000
    while ((bridge.state.heldReplies?.length ?? 0) === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(bridge.state.heldReplies?.length, 1)
    controller.abort(new Error('cancelled by caller'))
    bridge.state.heldReplies[0]()
    await rejected
    const opening = bridge.requests.find(request => request.op === 'ensureSidebar')
    const cancellation = bridge.requests.find(request => request.op === 'cancelSidebar')
    assert.equal(cancellation.transactionId, opening.transactionId)
    assert.equal(cancellation.handle, opening.handle)
    assert.equal(bridge.requests.some(request => request.op === 'cdp'), false)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('destroying a view while initialization is pending prevents the late reply from restoring or driving it', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [], protocol: 4, holdEnsure: true })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const view = host.createView(testTab('session-a'))
    const navigation = view.sendCommand('Page.navigate', { url: 'https://pending.example/' })
    const rejected = assert.rejects(navigation, /view was released/)
    const deadline = Date.now() + 1_000
    while ((bridge.state.heldReplies?.length ?? 0) === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(bridge.state.heldReplies?.length, 1, 'the initialization reached the bridge and is awaiting its reply')
    host.destroyView(view)
    bridge.state.heldReplies[0]()
    await rejected
    assert.equal(bridge.requests.some(request => request.op === 'cdp'), false, 'the released view never navigates the late guest')
    const before = bridge.requests.length
    host.showView(view, 'released', { quiet: true })
    await assert.rejects(view.sendCommand('Runtime.evaluate', { expression: 'document.title' }), /view was released/)
    assert.equal(bridge.requests.length, before, 'neither presentation nor later commands restore the released mapping')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('a closed guest fails without replaying the command in a new page', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover()
    const view = host.createView(testTab())
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    bridge.state.dead = [1]
    await assert.rejects(view.sendCommand('Runtime.evaluate', { expression: '2' }), { code: 'BROWSER_HANDLE_STALE' })
    assert.equal(bridge.requests.filter(r => r.op === 'ensureSidebar').length, 1)
    assert.ok(bridge.requests.filter(r => r.op === 'cdp').every(r => r.handle === view.id))
  } finally { host?.dispose(); await bridge.close() }
})
test('releasePage asks the shell to close the sidebar pages', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    await host.createView(testTab()).sendCommand('Runtime.evaluate', { expression: '1' })
    await host.releasePage()
    assert.ok(bridge.requests.some(r => r.op === 'closePage'), 'the shell was asked to close the bound page')
    assert.ok(bridge.requests.some(r => r.op === 'releaseSession'), 'the session was retired')
  } finally {
    bridge.close()
  }
})

test('releasePage names only this host\'s tabs, never every visible page', async () => {
  // Two sessions run on one sidebar (each view owns a tab). Releasing one must not
  // close the other's page: requirements §4 gives each session its own page, and a
  // blanket release would tear down a page somebody else is still driving.
  const bridge = await startFakeBridge({ tabs: 3, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    const view = host.createView(testTab())
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    host.destroyView({ id: view.id })
    await host.releasePage()

    const release = bridge.requests.find(r => r.op === 'closePage')
    assert.ok(release !== undefined, 'the release was sent')
    assert.equal(release.handle, view.id, 'only the tab this host opened was named')
  } finally {
    bridge.close()
  }
})

test('a release with nothing of our own does not touch the shell', async () => {
  const bridge = await startFakeBridge({ tabs: 2, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    await host.releasePage()
    assert.equal(
      bridge.requests.some(r => r.op === 'closeSidebarBrowser'),
      false,
      'a host that opened no tab releases nothing — a human may own both',
    )
  } finally {
    bridge.close()
  }
})

test('release refusal propagates without allowing the retired session to be recreated', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [], refuseRelease: true })
  withEndpoint(bridge.port)
  const host = await DesktopBridgeViewHost.discover()
  try {
    const identity = testTab()
    host.createView(identity)
    await assert.rejects(host.releasePage(sessionWireId(readTabHandle(identity))), /fixture release refused/)
    assert.throws(() => host.createView(identity), /session was released/)
    assert.equal(bridge.requests.filter(request => request.op === 'releaseSession').length, 1)
  } finally { host?.dispose(); await bridge.close() }
})

test('collapse folds the sidebar without releasing anything', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    host.createView(testTab())
    await host.collapse()
    assert.ok(bridge.requests.some(r => r.op === 'collapseSidebar'), 'the shell was asked to fold')
    assert.equal(
      bridge.requests.some(r => r.op === 'closeSidebarBrowser'),
      false,
      'folding must never end the page',
    )
  } finally {
    bridge.close()
  }
})

test('showView sends the canonical handle without exposing the native guest id', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const view = host.createView(testTab('session-a'))
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    host.showView(view)
    await new Promise(resolve => setTimeout(resolve, 30))
    const show = bridge.requests.find(request => request.op === 'showTab')
    assert.equal(show?.handle, view.id)
    assert.equal(show?.viewId, undefined)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('quiet presentation leaves the visible tab alone until selection is explicitly requested', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const view = host.createView(testTab('session-a'))
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    host.showView(view, 'quiet', { quiet: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(bridge.requests.some(request => request.op === 'showTab'), false, 'ordinary quiet reads and input never select a tab')
    host.showView(view, 'selected', { quiet: true, select: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    const selected = bridge.requests.filter(request => request.op === 'showTab')
    assert.equal(selected.length, 1, 'quiet mode still shows an explicitly requested sidebar tab')
    assert.equal(selected[0].handle, view.id)
    assert.equal(selected[0].viewId, undefined)
    assert.equal(readTabHandle(selected[0].handle).owner, 'session-a')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('quiet first navigation opens the selected sidebar and sends the URL to the requesting conversation', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [] })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover('session-a', () => true)
    host.onLost(reason => losses.push(reason))
    const view = host.createView(testTab('session-b'))
    const result = await view.sendCommand('Page.navigate', { url: 'https://unopened.example/' })
    assert.equal(result.echo, 'Page.navigate')
    const initialized = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(initialized.length, 1)
    assert.equal(readTabHandle(initialized[0].handle).owner, 'session-b')
    assert.equal(initialized[0].url, 'https://unopened.example/')
    const navigation = bridge.requests.find(request => request.op === 'cdp' && request.method === 'Page.navigate')
    assert.equal(navigation.handle, view.id)
    assert.equal(navigation.params.url, 'https://unopened.example/')
    await view.sendCommand('Runtime.evaluate', { expression: 'document.title' })
    assert.equal(bridge.requests.filter(request => request.op === 'ensureSidebar').length, 1, 'the attached page is reused')
    assert.deepEqual(losses, [], 'quiet initialization is not carrier loss')
    assert.equal(bridge.requests.some(request => request.op === 'ensureTabs'), false)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('quiet passive preview of an unopened sidebar still never initializes or navigates', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-preview', () => true)
    const view = host.createView(testTab('session-preview'))
    await assert.rejects(view.sendCommand('Page.captureScreenshot', {}, { present: false }), BrowserPanelNotDisplayedError)
    assert.equal(bridge.requests.some(request => request.op === 'ensureSidebar'), false)
    assert.equal(bridge.requests.some(request => request.op === 'cdp'), false)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('quiet document probes cannot launch an initialization that outlives a later URL navigation', async () => {
  const bridge = await startFakeBridge({ tabs: 0, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-probe', () => true)
    const view = host.createView(testTab('session-probe'))
    const before = bridge.requests.length
    await assert.rejects(view.sendCommand('Runtime.evaluate', { expression: 'performance.timeOrigin' }, { initialize: false }), error => {
      assert.ok(error instanceof BrowserPanelNotDisplayedError)
      assert.equal(error.code, 'panel-initializing')
      return true
    })
    assert.equal(bridge.requests.length, before, 'the passive probe sends no bridge request at all')
    await view.sendCommand('Page.navigate', { url: 'https://first-navigation.example/' })
    const requests = bridge.requests.filter(request => request.op === 'ensureSidebar')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://first-navigation.example/')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('carrier page listing and closing carry the requesting conversation identity', async () => {
  const bridge = await startFakeBridge({ tabs: 2, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const scope = testScope('session-b'), id = testTab('session-b', 'page:2')
    await host.listPages(scope)
    await host.closePage(id, scope)
    const list = bridge.requests.filter(request => request.op === 'list').at(-1)
    const close = bridge.requests.find(request => request.op === 'closePage')
    assert.equal(list.handle, scope)
    assert.equal(close.handle, id)
    bridge.state.closeCount = 0
    await assert.rejects(host.closePage(id, scope), /did not close|could not close/)
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

// Issue #37: a sidebar panel that is merely not on screen is a DISPLAY STATE, not a lost carrier.
//
// The report: switch to another conversation, call a browser tool, and the plugin reported the
// carrier lost, swapped to a self-hosted window, and the page that had been open was blank in it.
// The bridge's own message said the opposite — the page attaches as soon as the conversation is
// shown — but the plugin only matched on text, and that text shared a pattern with real loss.
test('a panel that is merely not displayed does not report the carrier as lost', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelNotDisplayed: true })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined, 'discovery succeeds: the shell is alive and answering')
    host.onLost(reason => losses.push(reason))
    const view = host.createView(testTab('session-a'))
    // A command is how a tool reaches ensureSidebar, so this is the reported path.
    await assert.rejects(
      view.sendCommand('Page.navigate', { url: 'https://example.com/' }),
      error => {
        assert.ok(error instanceof BrowserPanelNotDisplayedError,
          `expected a display-state error, got ${error?.name}: ${error?.message}`)
        assert.match(error.message, /sidebar page did not attach/i)
        return true
      },
    )
    assert.deepEqual(losses, [], 'a display state must never trigger the carrier-lost listener')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('a panel this shell can never drive still falls back', async () => {
  // The other half of the distinction: an iframe shell (issue #30) really is unusable, and refusing
  // to fall back there would make every call fail forever.
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelUnusable: true })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined)
    host.onLost(reason => losses.push(reason))
    const view = host.createView(testTab('session-a'))
    await assert.rejects(view.sendCommand('Page.navigate', { url: 'https://example.com/' }))
    assert.deepEqual(losses, ['panel-unusable'], 'an undrivable panel does fall back')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('explicit unusable evidence takes precedence over legacy no-page wording', async () => {
  const bridge = await startFakeBridge({
    tabs: 1,
    dead: [],
    panelUnusable: true,
    panelUnusableDetail: 'the sidebar produced no page because this shell has no drivable webview capability',
  })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined)
    host.onLost(reason => losses.push(reason))
    const view = host.createView(testTab('session-a'))
    await assert.rejects(
      view.sendCommand('Page.navigate', { url: 'https://example.com/' }),
      error => !(error instanceof BrowserPanelNotDisplayedError),
    )
    assert.deepEqual(losses, ['panel-unusable'])
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('an undisplayed sidebar refuses once without activating another conversation', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelNotDisplayedLeft: 2 })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    host.onLost(reason => losses.push(reason))
    const view = host.createView(testTab('session-a'))
    await assert.rejects(view.sendCommand('Page.navigate', { url: 'https://example.com/' }), { code: 'panel-not-displayed' })
    assert.equal(bridge.requests.filter(r => r.op === 'ensureSidebar').length, 1)
    assert.deepEqual(losses, [])
  } finally { host?.dispose(); await bridge.close() }
})

test('an uncoded legacy refusal surfaces without a wording-based retry', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelUncodedLeft: 1 })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover()
    const view = host.createView(testTab('session-a'))
    await assert.rejects(view.sendCommand('Page.navigate', { url: 'https://example.com/' }), /show it and the page appears/)
    assert.equal(bridge.requests.filter(r => r.op === 'ensureSidebar').length, 1)
  } finally { host?.dispose(); await bridge.close() }
})
