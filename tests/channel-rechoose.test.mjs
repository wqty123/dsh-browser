import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettings } from '../lib/browser-electron/settings-store.js'
import { carrierHarness, Sidebar } from './carrier-harness.mjs'

test('a mistyped channel is reported and coerced to the sidebar-only default', () => {
  const complaints = []
  const resolved = resolveSettings({ browser: { channel: 'edgeee' } }, message => complaints.push(message))
  assert.equal(resolved.browser.channel, 'sidebar')
  assert.equal(complaints.length, 1)
  assert.match(complaints[0], /edgeee/)
  assert.match(complaints[0], /chrome, edge, auto, bundled, sidebar/)
})

test('a channel that is absent is the ordinary case, not a mistake', () => {
  const complaints = []
  assert.equal(resolveSettings({ browser: {} }, message => complaints.push(message)).browser.channel, 'sidebar')
  assert.equal(resolveSettings({}, message => complaints.push(message)).browser.channel, 'sidebar')
  assert.deepEqual(complaints, [])
})

test('a valid channel says nothing at all', () => {
  const complaints = []
  assert.equal(resolveSettings({ browser: { channel: 'edge' } }, message => complaints.push(message)).browser.channel, 'edge')
  assert.deepEqual(complaints, [])
})

test('settings changes rechoose the carrier and release the previous selection', async t => {
  const h = carrierHarness(t)
  const initial = h.current
  assert.equal((await h.choose('chrome')).carrierRechosen, true)
  const chrome = h.current
  assert.notEqual(chrome, initial)
  assert.equal(initial.available(), false)
  assert.equal((await h.choose('sidebar')).carrierRechosen, true)
  assert.equal(chrome.available(), false)
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
})

test('a settings response distinguishes a changed channel from an unchanged one', async t => {
  const h = carrierHarness(t)
  assert.equal((await h.choose('sidebar')).carrierRechosen, undefined)
  assert.equal(h.registered.length, 1)
  assert.equal((await h.choose('auto')).carrierRechosen, true)
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
})

test('explicit browser modes outrank a composition sidebar and can switch back without disposing it', async t => {
  const supplied = new Sidebar()
  const h = carrierHarness(t, { viewHost: supplied })
  assert.equal(h.current, supplied)
  await h.choose('edge', 'user')
  assert.equal(h.current.constructor.name, 'PreferredBrowserViewHost')
  assert.equal(supplied.disposed, false)
  await h.choose('sidebar')
  assert.equal(h.current, supplied)
  await h.choose('chrome', 'plugin')
  assert.equal(h.current.constructor.name, 'SystemBrowserViewHost')
  assert.equal(supplied.disposed, false)
})
