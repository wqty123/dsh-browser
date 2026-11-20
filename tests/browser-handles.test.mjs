import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserSessionHandle, resolveTabHandle, scopedTabs, sessionWireId, tabWireId } from '../lib/browser/handles.js'
import { apply } from '../lib/tool-browser/index.js'

test('canonical handles preserve opaque identities over JSON without conflating their namespaces', () => {
  const scope = browserSessionHandle('session-新会话:%/', 'browser:a/b:%')
  for (const tab of ['tab:a/b:%', 'page:42', 'same-id']) {
    const handle = { ...scope, tab }
    const wire = JSON.parse(JSON.stringify(tabWireId(handle)))
    assert.deepEqual(resolveTabHandle(scope, wire), handle)
    assert.equal(tabWireId(resolveTabHandle(scope, wire)), wire)
    assert.notEqual(sessionWireId(scope), wire)
  }
  assert.deepEqual(scopedTabs(scope, []), [])
  assert.throws(() => browserSessionHandle('', 'browser:1'), /nonempty/)
  assert.throws(() => tabWireId({ ...scope, tab: '' }), /nonempty/)
})

test('untrusted wire handles reject malformed, noncanonical, stale and foreign identities', () => {
  const scope = browserSessionHandle('owner', 'browser:1')
  for (const wire of ['', 'tab:bare', 'page:42', 'dsh-tab:v2:[]', 'dsh-tab:v1:%', 'dsh-tab:v1:null', 'dsh-tab:v1:%5B%22owner%22%5D', 'dsh-tab:v1:%5B%22owner%22%2C%22browser%3A1%22%2C%22%22%5D']) {
    assert.throws(() => resolveTabHandle(scope, wire), /invalid tab handle/, wire)
  }
  for (const handle of [{ ...scope, owner: 'foreign', tab: 'tab:1' }, { ...scope, session: 'browser:old', tab: 'tab:1' }]) {
    assert.throws(() => resolveTabHandle(scope, tabWireId(handle)), /not open in this owner\/session/)
  }
  const noncanonical = 'dsh-tab:v1:' + encodeURIComponent('["owner", "browser:1", "tab:1"]')
  assert.throws(() => resolveTabHandle(scope, noncanonical), /noncanonical/)
})

function toolsFor(browser) {
  const tools = new Map()
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, effect() {},
    get: name => name === 'browser' ? browser : undefined })
  return async (name, args = {}, owner = 'owner') => JSON.parse(JSON.stringify(await tools.get('dsh_browser_' + name).execute(
    JSON.parse(JSON.stringify(args)), { signal: new AbortController().signal, agent: { id: owner } },
  )))
}

test('registered tool RPCs round-trip listed tab handles, refuse foreign/stale handles and propagate errors', async () => {
  const calls = []
  let revision = 1
  const browser = {
    open: async owner => `${owner}:${revision}`,
    exists: session => session.endsWith(`:${revision}`),
    close: async () => {}, openUrl: async () => {},
    snapshot: async () => ({ url: 'https://example.test', elements: [], truncated: false }),
    listTabs: async () => [{ id: 'page:42', url: 'https://example.test', active: true }],
    switchTab: async (...args) => { calls.push(['switch', ...args]) },
    closeTab: async (...args) => { calls.push(['close', ...args]); throw new Error('native close refused') },
  }
  const run = toolsFor(browser)
  for (const owner of ['owner', 'other']) await run('open', { url: 'https://example.test', surface: 'builtin' }, owner)
  const listed = await run('list_tabs')
  const id = listed.tabs[0].id
  assert.deepEqual((await run('session')).tabs, listed.tabs)
  assert.match((await run('session')).session, /^dsh-session:v1:/)
  assert.deepEqual(await run('switch_tab', { tabId: id }), { switched: true })
  assert.deepEqual(calls, [['switch', 'owner:1', 'page:42']])
  await assert.rejects(run('switch_tab', { tabId: id }, 'other'), /owner\/session/)
  await assert.rejects(run('close_tab', { tabId: 'page:42' }), /invalid tab handle/)
  assert.equal(calls.length, 1, 'refused handles never reach the provider')
  await assert.rejects(run('close_tab', { tabId: id }), /native close refused/)
  browser.closeTab = async (...args) => { calls.push(['close', ...args]) }
  assert.deepEqual(await run('close_tab', { tabId: id }), { closed: true })
  browser.listTabs = async () => []
  assert.deepEqual(await run('list_tabs'), { tabs: [] })
  revision++
  await run('open', { url: 'https://example.test', surface: 'builtin' })
  await assert.rejects(run('close_tab', { tabId: id }), /owner\/session/)
})
