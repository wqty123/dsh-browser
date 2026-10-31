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

import { BrowserPanelNotDisplayedError, DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'

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
              return { ok: false, error: 'the sidebar produced no page for this conversation' }
            }
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
          if (request.op === 'closePage') return { ok: true, closed: state.closeCount ?? 1 }
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

test('showView sends the materialized numeric guest instead of the UUID view id', async () => {
  const bridge = await startFakeBridge({ tabs: 1, dead: [] })
  withEndpoint(bridge.port)
  let host
  try {
    host = await DesktopBridgeViewHost.discover('session-a')
    const view = host.createView('session-a')
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    host.showView(view)
    await new Promise(resolve => setTimeout(resolve, 30))
    const show = bridge.requests.find(request => request.op === 'showTab')
    assert.equal(show?.viewId, 1, 'the guest id is sent, never NaN/null')
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
    await host.listPages('session-b')
    await host.closePage('2', 'session-b')
    const list = bridge.requests.filter(request => request.op === 'list').at(-1)
    const close = bridge.requests.find(request => request.op === 'closePage')
    assert.equal(list.owner, 'session-b')
    assert.equal(close.owner, 'session-b')
    assert.equal(close.id, 2)
    bridge.state.closeCount = 0
    await assert.rejects(host.closePage('2', 'session-b'), /did not close|could not close/)
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
    const view = host.createView('session-a')
    // A command is how a tool reaches ensureSidebar, so this is the reported path.
    await assert.rejects(
      view.sendCommand('Page.navigate', { url: 'https://example.com/' }),
      error => {
        assert.ok(error instanceof BrowserPanelNotDisplayedError,
          `expected a display-state error, got ${error?.name}: ${error?.message}`)
        assert.match(error.message, /nothing was lost/i,
          'and it must say so, because the old message read like a failure')
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
    const view = host.createView('session-a')
    await assert.rejects(view.sendCommand('Page.navigate', { url: 'https://example.com/' }))
    assert.deepEqual(losses, ['panel-unusable'], 'an undrivable panel does fall back')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('a display refusal is retried while the shell renders the conversation it was asked to show', async () => {
  // The client half asks the shell to display the conversation a page was requested for
  // (`openSession`), and React renders that one pass later. Failing the tool call on the first
  // refusal reported a problem the plugin had already fixed, and left the page — which IS there —
  // reachable only by a second call. The retry is what makes one call enough.
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelNotDisplayedLeft: 2 })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined)
    host.onLost(reason => losses.push(reason))
    const view = host.createView('session-a')
    const answer = await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.equal(answer.echo, 'Page.navigate', 'the command reached the page that had just appeared')
    const attempts = bridge.requests.filter(request => request.op === 'ensureSidebar').length
    assert.equal(attempts, 3, 'two refusals were retried; the third landed — no more, no fewer')
    assert.deepEqual(losses, [], 'a transient display state still never reports the carrier as lost')
  } finally {
    host?.dispose()
    await bridge.close()
  }
})

test('a bridge from before the display-state code is recognised by its wording', async () => {
  // The installed bridge on a machine that never reinstalled it answers the SAME refusal without a
  // code. Reading only the code made that refusal a hard failure — the exact opposite of the
  // behaviour the code was added for — so the wording is matched too.
  const bridge = await startFakeBridge({ tabs: 1, dead: [], panelUncodedLeft: 1 })
  withEndpoint(bridge.port)
  let host
  const losses = []
  try {
    host = await DesktopBridgeViewHost.discover()
    assert.ok(host !== undefined)
    host.onLost(reason => losses.push(reason))
    const view = host.createView('session-a')
    const answer = await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    assert.equal(answer.echo, 'Page.navigate', 'the uncoded refusal was retried, not fatal')
    const attempts = bridge.requests.filter(request => request.op === 'ensureSidebar').length
    assert.equal(attempts, 2, 'exactly one retry was needed')
    assert.deepEqual(losses, [])
  } finally {
    host?.dispose()
    await bridge.close()
  }
})
