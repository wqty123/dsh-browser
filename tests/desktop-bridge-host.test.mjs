// The desktop sidebar host talks to the shell over a loopback bridge. These tests
// stand up a fake bridge (same protocol) so the host's behaviour is pinned without
// a desktop app: discovery rejects dead endpoints, commands are forwarded, each
// view takes its own tab, and a tab the human closed is replaced rather than
// reused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'

/** A fake shell bridge: records requests, answers with scripted state. */
async function startFakeBridge(state = { tabs: 1, dead: [] }) {
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
            const sidebar = []
            for (let i = 1; i <= state.tabs; i++) {
              if (state.dead.includes(i)) continue
              sidebar.push({ id: i, type: 'webview', url: `https://page${i}.example/`, title: `Page ${i}`, destroyed: false })
            }
            return { ok: true, guests: sidebar, sidebar }
          }
          if (request.op === 'ensureSidebar') {
            // The real op answers with the page THIS conversation's panel holds, and that page
            // changes when the human closes its tab. Returning a fixed id made the recovery path
            // untestable: the host would be handed the id it had just proven dead.
            let id = 1
            while (state.dead.includes(id) && id < 50) id += 1
            return { ok: true, created: state.tabs === 0, id, prepared: 'OPENED_AND_FOCUSED', via: 'panel' }
          }
          if (request.op === 'ensureTabs') {
            state.tabs = Math.max(state.tabs, Number(request.count ?? 1))
            // A closed tab frees its slot: the real sidebar would hand out a NEW id,
            // never the id of a guest that no longer exists.
            const ids = []
            for (let candidate = 1; ids.length < Number(request.count ?? 1) && candidate <= 50; candidate++) {
              if (!state.dead.includes(candidate)) ids.push(candidate)
            }
            return { ok: true, ids }
          }
          if (request.op === 'cdp') {
            // A closed tab makes the real bridge answer exactly like this; the host
            // must treat it as "the page is gone", not as a command failure.
            if (state.dead.includes(Number(request.id))) return { ok: false, error: `guest ${request.id} is not available` }
            return { ok: true, result: { echo: request.method, guest: request.id } }
          }
          if (request.op === 'closeSidebarBrowser') return { ok: true, closed: state.tabs }
          if (request.op === 'collapseSidebar') return { ok: true, result: 'COLLAPSED' }
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
    const view = host.createView()
    const answer = await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.equal(answer.echo, 'Page.navigate')
    assert.ok(bridge.requests.some(r => r.op === 'cdp' && r.method === 'Page.navigate'), 'the command reached the bridge')
  } finally {
    bridge.close()
  }
})

test('every view of one conversation drives that conversation\'s one page', async () => {
  // This carrier exists so a human and the agent look at the SAME page, and the shell keeps one
  // browser page per conversation. Two views are therefore two handles on one guest: the provider
  // keeps its own tab bookkeeping, and the page does not multiply behind it. Keeping a page per
  // view is what the self-hosted carrier does, and it is what this one deliberately does not.
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    const first = host.createView()
    await first.sendCommand('Runtime.evaluate', { expression: '1' })
    const second = host.createView()
    await second.sendCommand('Runtime.evaluate', { expression: '2' })

    const guestIds = bridge.requests.filter(r => r.op === 'cdp').map(r => r.id)
    assert.equal(new Set(guestIds).size, 1, 'both views drove the same page')
    assert.ok(bridge.requests.some(r => r.op === 'ensureSidebar'), 'and each asked for its conversation page')
    assert.ok(!bridge.requests.some(r => r.op === 'ensureTabs'),
      'the strip is never grown to satisfy a second view: there is no second page to grow it for')
  } finally {
    bridge.close()
  }
})

test('a tab the human closed is replaced instead of reused', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    const view = host.createView()
    await view.sendCommand('Runtime.evaluate', { expression: '1' })

    // The human closes the tab: commands to that guest now fail the way the bridge
    // reports a missing guest.
    bridge.state.dead = [1]
    bridge.state.tabs = 1

    const answer = await view.sendCommand('Runtime.evaluate', { expression: '2' })
    assert.ok(answer !== undefined, 'the view recovered instead of surfacing a dead guest')

    // Recovery is driven by the failure itself — no liveness probe before every
    // command. The exact number of attempts is not the contract (the provider layer
    // retries too); what matters is that the dead guest is abandoned for a live one,
    // and never returned to.
    const attempts = bridge.requests.filter(r => r.op === 'cdp').map(r => r.id)
    assert.equal(attempts[0], 1, 'the first attempt went to the cached guest')
    assert.ok(attempts.includes(2), 'recovery moved to a replacement guest')
    assert.equal(attempts.lastIndexOf(1) < attempts.indexOf(2), true, 'the dead guest is never retried afterwards')
  } finally {
    bridge.close()
  }
})

// Requirements §3: on this carrier our own view handles are not enough — the
// sidebar is the shell's and would keep the page alive. Releasing has to be asked
// for, and folding has to be asked for separately (it must not end the page).
test('releasePage asks the shell to close the sidebar pages', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
    await host.releasePage()
    assert.ok(bridge.requests.some(r => r.op === 'closeSidebarBrowser'), 'the shell was asked to release the pages')
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
    const view = host.createView()
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    host.destroyView({ id: view.id })
    await host.releasePage()

    const release = bridge.requests.find(r => r.op === 'closeSidebarBrowser')
    assert.ok(release !== undefined, 'the release was sent')
    assert.deepEqual(release.titles, ['Page 1'], 'only the tab this host opened was named')
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

test('collapse folds the sidebar without releasing anything', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  try {
    const host = await DesktopBridgeViewHost.discover()
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
