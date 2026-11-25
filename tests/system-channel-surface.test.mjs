// Issue #106: when the user explicitly selects Chrome or Edge (including the default
// plugin profile), dsh_browser_open on Web must drive that installed browser carrier rather
// than falling back to the Web iframe panel. Also verifies that probing non-Desktop candidate
// directories does not spam console.error on ENOENT.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSurface } from '../lib/tool-browser/state.js'
import { apply } from '../lib/tool-browser/index.js'
import { clearLastOpen, getLastOpen } from '../lib/browser-electron/open-slot.js'
import { readDesktopIdentity } from '../lib/browser-electron/desktop-identity.js'

function withTempHome(t, settings) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-issue106-'))
  const previousHome = process.env.DSH_HOME
  const previousSurface = globalThis.__dshBrowserSurface
  process.env.DSH_HOME = home
  delete globalThis.__dshBrowserSurface
  if (settings !== undefined) {
    mkdirSync(join(home, 'dsh-builtin-browser-host'), { recursive: true })
    writeFileSync(join(home, 'dsh-builtin-browser-host', 'settings.json'), JSON.stringify(settings))
  }
  t.after(() => {
    clearLastOpen()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousSurface === undefined) delete globalThis.__dshBrowserSurface
    else globalThis.__dshBrowserSurface = previousSurface
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('readSurface resolves explicit chrome/edge/electron channels to builtin even when Web declared panel', t => {
  const home = withTempHome(t)
  assert.equal(readSurface(), 'panel', 'default without settings stays panel')
  mkdirSync(join(home, 'dsh-builtin-browser-host'), { recursive: true })
  const file = join(home, 'dsh-builtin-browser-host', 'settings.json')

  for (const channel of ['chrome', 'edge', 'electron']) {
    writeFileSync(file, JSON.stringify({ browser: { channel, systemProfile: 'plugin' } }))
    assert.equal(readSurface(), 'builtin', `${channel} defaults to builtin`)
    globalThis.__dshBrowserSurface = 'panel'
    assert.equal(readSurface(), 'builtin', `${channel} overrides a Web panel declaration`)
    delete globalThis.__dshBrowserSurface
  }

  writeFileSync(file, JSON.stringify({ browser: { channel: 'sidebar', systemProfile: 'plugin' } }))
  assert.equal(readSurface(), 'panel', 'sidebar channel stays panel')

  writeFileSync(file, JSON.stringify({ browser: { channel: 'chrome', surface: 'panel' } }))
  assert.equal(readSurface(), 'panel', 'explicit browser.surface still wins')
})

test('Web dsh_browser_open with channel=chrome drives the system browser instead of queueing an iframe', async t => {
  const home = withTempHome(t, {
    browser: { channel: 'chrome', headless: 'auto', systemProfile: 'plugin' },
    ui: { quiet: false, autoExpandOnce: false },
  })
  clearLastOpen()

  const calls = []
  let url = ''
  const browser = {
    open: async label => { calls.push(['open', label]); return 'browser:chrome-1' },
    openPanel: async () => { calls.push(['openPanel']); return undefined },
    exists: id => id === 'browser:chrome-1',
    close: async id => { calls.push(['close', id]) },
    openUrl: async (session, request) => { calls.push(['openUrl', session, request.url]); url = request.url },
    snapshot: async session => {
      calls.push(['snapshot', session])
      return { url, title: '百度一下，你就知道', elements: [], truncated: false }
    },
    pageOperation: async (session, request) => {
      calls.push(['pageOperation', session, request.operation, request.method])
      if (request.operation === 'install') return { ok: true, value: 8 }
      if (request.operation === 'probe' && request.method === 'summary') {
        return {
          ok: true,
          value: JSON.stringify({
            url, title: '百度一下，你就知道', readyState: 'complete', pending: 0, quietMs: 500,
            inputs: 1, buttons: 1, links: 1, scrollX: 0, scrollY: 0, selection: '', text: '百度一下，你就知道',
          }),
        }
      }
      return { ok: true, value: '{}' }
    },
  }

  const tools = new Map()
  const cleanups = []
  const exec = {
    signal: new AbortController().signal,
    agent: { id: 'web-chrome-task', session: { header: { cwd: home } }, ctx: { effect: fn => { cleanups.push(fn()) } } },
  }
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
    effect() {},
    get: name => name === 'browser' ? browser : undefined,
  }, { surface: 'tools' })
  t.after(() => { for (const cleanup of cleanups) cleanup?.() })

  const opened = await tools.get('dsh_browser_open').execute({ url: 'https://www.baidu.com/' }, exec)
  assert.notEqual(opened.carrier, 'panel-iframe-navigation-requested')
  assert.equal(opened.title, '百度一下，你就知道')
  assert.equal(calls.some(([name]) => name === 'openPanel'), false, 'must not route through openPanel')
  assert.equal(calls.some(([name]) => name === 'open'), true, 'must open the selected Chrome carrier')
  assert.equal(getLastOpen(), undefined, 'must not echo an iframe open request to the Web sidebar')

  const state = await tools.get('dsh_browser_state').execute({}, exec)
  assert.equal(state.summary.title, '百度一下，你就知道')

  // An explicit per-call surface: 'panel' still reaches the panel path.
  const explicitPanel = await tools.get('dsh_browser_open').execute({ url: 'https://example.com/', surface: 'panel' }, exec)
  assert.equal(explicitPanel.carrier, 'panel-iframe-navigation-requested')
})

test('readDesktopIdentity does not spam console.error on ENOENT candidate directories', t => {
  const missing = mkdtempSync(join(tmpdir(), 'dsh-not-desktop-'))
  t.after(() => rmSync(missing, { recursive: true, force: true }))
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  t.after(() => { console.error = originalError })

  const identity = readDesktopIdentity(missing)
  assert.equal(identity.ok, false)
  assert.deepEqual(errors, [], 'expected ENOENT candidate probe must stay silent')
})
