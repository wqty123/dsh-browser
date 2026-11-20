import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ElectronBrowserProvider } = await import(process.env.BROWSER_PROVIDER_UNDER_TEST
  ?? new URL('../lib/browser-electron/provider.js', import.meta.url).href)

test('sidebar overlay queues have one client consumer; external carriers retain their provider pump', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const owner of ['client', undefined]) {
    let discoveries = 0
    const provider = new ElectronBrowserProvider({
      referenceOverlayOwner: owner,
      createView: () => { throw new Error('unexpected view') }, destroyView() {}, showView() {},
      listPages: async () => { discoveries++; return [] },
      adoptPage: async () => { throw new Error('unexpected page') },
    }, { referenceLabel: () => 'reference-owner', history: { enabled: false } })
    try {
      t.mock.timers.tick(1200)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(discoveries, owner === 'client' ? 0 : 1)
    } finally { provider.dispose() }
  }
})

function fixture({ listing = true, readFails = false } = {}) {
  const calls = { adopted: [], evaluated: [], destroyed: [] }
  const page = { id: 'native-55', url: 'https://example.test/adopted' }
  const handle = {
    id: page.id,
    async sendCommand(method, params) {
      calls.evaluated.push({ method, expression: params?.expression })
      if (params?.expression === 'location.href') {
        if (readFails) throw new Error('page disappeared during adoption')
        return { result: { value: page.url } }
      }
      return { result: { value: { url: page.url, elements: [], nodes: [], count: 1, truncated: false } } }
    },
  }
  const host = {
    createView: () => ({ id: 'uninitialized', sendCommand: async () => ({}) }),
    destroyView: value => calls.destroyed.push(value.id),
    showView() {},
    ...(listing ? { listPages: async owner => {
      assert.equal(owner, 'session-adoption-test')
      return [page]
    } } : {}),
    adoptPage: async (id, owner) => { calls.adopted.push({ id, owner }); return handle },
  }
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  return { calls, page, provider }
}

test('a carrier page is readable immediately after switching to it and is adopted once', async () => {
  const { provider, calls, page } = fixture()
  const session = await provider.open('session-adoption-test')
  await provider.switchTab(session, `page:${page.id}`)
  const snapshot = await provider.snapshot(session)
  const a11y = await provider.a11y(session, {})
  assert.equal(snapshot.url, page.url)
  assert.notEqual(snapshot.blank, true)
  assert.equal(a11y.url, page.url)
  assert.ok(calls.evaluated.length >= 2, 'both readers evaluate the adopted document instead of short-circuiting')
  await provider.switchTab(session, `page:${page.id}`)
  assert.deepEqual(calls.adopted, [{ id: page.id, owner: 'session-adoption-test' }])
  await provider.close(session)
})

test('an adoption without page metadata reads the committed URL before succeeding', async () => {
  const { provider, page } = fixture({ listing: false })
  const session = await provider.open('session-adoption-test')
  await provider.switchTab(session, `page:${page.id}`)
  assert.equal((await provider.snapshot(session)).url, page.url)
  await provider.close(session)
})

test('a failed adopted-document read releases only the new handle and keeps the prior active tab', async () => {
  const { provider, page, calls } = fixture({ listing: false, readFails: true })
  const session = await provider.open('session-adoption-test')
  await assert.rejects(provider.switchTab(session, `page:${page.id}`), /page disappeared during adoption/)
  assert.deepEqual(calls.destroyed, [page.id])
  assert.equal((await provider.snapshot(session)).blank, true)
  await provider.close(session)
})
