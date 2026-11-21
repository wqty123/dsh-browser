import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carrierHarness, Sidebar } from './carrier-harness.mjs'

test('a lost shell retires its cached panel and the next open discovers a fresh connection', async t => {
  const first = new Sidebar(), second = new Sidebar()
  let discoveries = 0
  const h = carrierHarness(t, { discover: async () => ++discoveries === 1 ? first : second })
  const provider = await h.openPanel()
  assert.equal(await h.openPanel(), provider)
  assert.equal(discoveries, 1)
  const session = await provider.open('owner')
  first.lose('shell-exited')
  assert.equal(provider.exists(session), false)
  const replacement = await h.openPanel()
  assert.notEqual(replacement, provider)
  assert.equal(discoveries, 2)
  first.lose('shell-exited')
  assert.equal(await h.openPanel(), replacement, 'late loss cannot evict the new shell')
  await new Promise(setImmediate)
  assert.equal(first.disposed, true)
  assert.equal(second.disposed, false)
})

test('a missing sidebar is not cached and a later open can connect', async t => {
  let ready = false
  const h = carrierHarness(t, { discover: async () => ready ? new Sidebar() : undefined })
  assert.equal(await h.openPanel(), undefined)
  ready = true
  assert.ok(await h.openPanel())
})

test('a failed panel discovery is not cached', async t => {
  let ready = false
  const h = carrierHarness(t, { discover: async () => { if (!ready) throw new Error('offline'); return new Sidebar() } })
  await assert.rejects(h.openPanel(), /offline/)
  ready = true
  assert.ok(await h.openPanel())
})
