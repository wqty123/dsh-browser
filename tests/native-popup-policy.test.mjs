import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const host = readFileSync(new URL('../src/browser-electron/host-main.ts', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')

function popupHandler(windowId) {
  const start = host.indexOf('view.webContents.setWindowOpenHandler(({ url }) => {')
  assert.notEqual(start, -1)
  const end = host.indexOf('\n        })', start)
  assert.notEqual(end, -1)
  const actions = [], loads = []
  let handler
  vm.runInNewContext(host.slice(start, end + '\n        })'.length), {
    view: { webContents: {
      setWindowOpenHandler(value) { handler = value },
      loadURL(url) { loads.push(url); return Promise.resolve() },
    } },
    win: { windowId }, SHARED_WINDOW_ID: 'shared',
    sendUserAction(action) { actions.push(action) },
  })
  return { handler, actions, loads }
}

test('HTTP(S) popups remain session tabs but never native windows', () => {
  const { handler, actions, loads } = popupHandler('session-a')
  for (const url of ['https://example.test/next', 'http://example.test/next']) {
    assert.equal(handler({ url }).action, 'deny')
    assert.equal(actions.at(-1).type, 'newTab')
    assert.equal(actions.at(-1).windowId, 'session-a')
    assert.equal(actions.at(-1).url, url)
  }
  assert.equal(actions.length, 2)
  assert.deepEqual(loads, [])
})

test('ungrouped HTTP(S) popups keep the existing in-view fallback', () => {
  const { handler, actions, loads } = popupHandler('shared')
  assert.equal(handler({ url: 'https://example.test/next' }).action, 'deny')
  assert.deepEqual(actions, [])
  assert.deepEqual(loads, ['https://example.test/next'])
})

test('blank, non-HTTP and malformed popup requests are refused without navigation', () => {
  for (const owner of ['session-a', 'shared']) {
    const { handler, actions, loads } = popupHandler(owner)
    for (const url of ['', 'about:blank', 'about:blank#login', 'mailto:user@example.test',
      'custom:login', 'file:///private/file', 'data:text/html,hello', 'javascript:void(0)', 'not a URL']) {
      assert.equal(handler({ url }).action, 'deny', url)
    }
    assert.deepEqual(actions, [])
    assert.deepEqual(loads, [])
  }
  assert.doesNotMatch(host, /action:\s*['"]allow['"]/)
  assert.match(host, /w\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
})

test('bridge blocks native windows for existing and future webview guests', () => {
  const match = bridge.match(/const onGuestCreated = \(_event, contents\) => \{([\s\S]*?)\n  \}/)
  assert.ok(match)
  const configured = [], fallbacks = []
  const onGuestCreated = vm.runInNewContext(`(_event, contents) => {${match[1]}\n}`, {
    applySidebarGuestProxy(contents) { configured.push(contents) },
    attachProxyFallback(contents) { fallbacks.push(contents) },
  })
  for (const type of ['webview', 'window']) {
    let handler
    const contents = { getType: () => type, setWindowOpenHandler(value) { handler = value } }
    onGuestCreated(undefined, contents)
    if (type === 'webview') {
      for (const url of ['https://example.test', 'about:blank', 'custom:login', '']) {
        assert.equal(handler({ url }).action, 'deny')
      }
    } else assert.equal(handler, undefined)
    assert.equal(configured.at(-1), contents)
    assert.equal(fallbacks.at(-1), contents)
  }
  assert.match(bridge, /application\.on\('web-contents-created', onGuestCreated\)/)
  assert.match(bridge, /for \(const contents of webContents\.getAllWebContents\(\)\) \{\s*onGuestCreated\(undefined, contents\)/)
})
