import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHostPatchMaintenance, servedSidebarPackage } from '../src/browser-electron/host-patch-maintenance.ts'
import { loadSettingsPanel } from '../src/client/settings/panel.ts'
import { hostPatchFixture } from './helpers/host-patch-fixture.mjs'

const sidebar = '@deepseek-ai/dsh-client-ui-sidebar-right'
const before = hostPatchFixture('client', 'before')
const after = hostPatchFixture('client', 'after')
function fixture(t, layout = 'node_modules/@deepseek-ai/dsh-client-ui-sidebar-right', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'web-host-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, layout)
  const file = join(pkg, 'lib/client.js')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: sidebar, version: options.version ?? '0.2.2-rc.3' }))
  writeFileSync(file, before)
  const rebuilt = []
  const registry = { clientPath: id => { assert.equal(id, sidebar); return file }, rebuilt: id => rebuilt.push(id) }
  const handler = createHostPatchMaintenance({ modules: () => options.missing ? undefined : options.registry ?? registry,
    desktop: () => options.desktop ?? false })
  const request = async (options = {}) => {
    const req = Readable.from([options.body ?? JSON.stringify({ action: options.action ?? 'install' })])
    req.method = options.method ?? 'GET'
    req.headers = { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', ...options.headers }
    req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(code) { this.statusCode = code },
      end(body) { this.body = JSON.parse(body) } })
    await handler(req, res)
    return res
  }
  return { pkg, file, request, registry, rebuilt }
}

for (const layout of ['installation/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right', 'checkout/packages/client/ui-sidebar-right']) {
  test(`settings patches only the running registry's package: ${layout}`, async t => {
    const f = fixture(t, layout)
    assert.equal(servedSidebarPackage(f.registry), f.pkg)
    const status = (await f.request()).body.hostPatch
    assert.equal(status.status, 'absent'); assert.equal(status.canInstall, true)
    assert.equal(existsSync(f.file + '.before-dsh-host-patch'), false)
    const applied = await f.request({ method: 'POST' })
    assert.equal(applied.statusCode, 200)
    assert.equal(applied.body.hostPatch.status, 'applied')
    assert.equal(applied.body.hostPatch.restartRequired, false)
    assert.equal(applied.body.hostPatch.canRestore, true)
    assert.equal(readFileSync(f.file, 'utf8'), after)
    assert.deepEqual(f.rebuilt, [sidebar])
    const restored = await f.request({ method: 'POST', action: 'restore' })
    assert.equal(restored.body.ok, true)
    assert.equal(restored.body.hostPatch.status, 'absent')
    assert.equal(readFileSync(f.file, 'utf8'), before)
    assert.deepEqual(f.rebuilt, [sidebar, sidebar])
  })
}

test('older registries without cache refresh require restart rather than promising reload alone', async t => {
  const f = fixture(t)
  delete f.registry.rebuilt
  const r = await f.request({ method: 'POST' })
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hostPatch.restartRequired, true)
})

test('a cache refresh failure reports that files changed and a restart is required', async t => {
  const f = fixture(t)
  f.registry.rebuilt = () => { throw new Error('refresh failed') }
  const r = await f.request({ method: 'POST' })
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hostPatch.restartRequired, true)
  assert.match(r.body.hostPatch.reason, /refresh failed/)
})

test('missing service, unsupported version, anchors mismatch and read-only package stay disabled with reasons', async t => {
  for (const options of [{ missing: true }, { version: '0.2.2-rc.4' }, { mismatch: true }, { readOnly: true }]) {
    const f = fixture(t, undefined, options)
    if (options.mismatch) writeFileSync(f.file, 'unknown bundle')
    if (options.readOnly) { chmodSync(f.file, 0o444); t.after(() => { if (existsSync(f.file)) chmodSync(f.file, 0o644) }) }
    const initial = readFileSync(f.file, 'utf8')
    const r = await f.request()
    assert.equal(r.statusCode, 200)
    assert.equal(r.body.hostPatch.canInstall, false)
    assert.equal(r.body.hostPatch.canRestore, false)
    assert.ok(r.body.hostPatch.reason)
    assert.equal((await f.request({ method: 'POST' })).statusCode, 409)
    assert.equal(readFileSync(f.file, 'utf8'), initial)
    assert.equal(existsSync(f.file + '.before-dsh-host-patch'), false)
  }
})

test('untrusted requests and invalid actions cannot mutate the served package', async t => {
  const f = fixture(t)
  for (const options of [{ remoteAddress: '192.168.1.1' }, { headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { origin: 'https://foreign.invalid' } }, { body: '{}' }, { body: 'null' }, { body: 'bad json' }, { method: 'DELETE' }]) {
    const r = await f.request({ method: 'POST', ...options })
    assert.ok([400, 403, 405].includes(r.statusCode))
    assert.equal(readFileSync(f.file, 'utf8'), before)
  }
})

test('Desktop status defers to closed-application bridge maintenance', async t => {
  const f = fixture(t, undefined, { desktop: true })
  assert.equal((await f.request()).body.hostPatch.surface, 'desktop')
  assert.equal((await f.request({ method: 'POST' })).statusCode, 409)
  assert.equal(readFileSync(f.file, 'utf8'), before)
})

function panel(t, answer) {
  const states = []; const refs = []; let cursor = 0; let refCursor = 0; let mounted = false
  const effects = []; const cleanup = []; const calls = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value }] },
    useRef: initial => refs[refCursor++] ?? (refs[refCursor - 1] = { current: initial }),
    useEffect: effect => { if (!mounted) effects.push(effect) },
    useCallback: fn => fn,
  }
  t.mock.method(globalThis, 'setInterval', () => 0)
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => { calls.push(init); return answer(init) })
  const exports = loadSettingsPanel(() => react)
  exports.apply({ effect: fn => { const end = fn(); if (typeof end === 'function') cleanup.push(end) },
    locale: { register() {}, bind: () => key => key }, slots: { inject: (_name, fn) => fn(), register() {} }, inject() {} })
  t.after(() => { for (const end of cleanup.reverse()) end() })
  const render = () => { cursor = 0; refCursor = 0; return exports.__hostPatchSection() }
  const mount = async () => { render(); for (const fn of effects.splice(0)) { const end = fn(); if (typeof end === 'function') cleanup.push(end) }; mounted = true; await new Promise(setImmediate); return render() }
  return { calls, mount, render, unmount: () => { for (const end of cleanup.splice(0).reverse()) end() } }
}
const elements = node => node == null ? [] : Array.isArray(node) ? node.flatMap(elements) : typeof node === 'object' ? [node, ...elements(node.children)] : []
const text = node => JSON.stringify(node)

test('Web settings install and restore buttons send explicit actions and explain reload versus restart', async t => {
  let applied = false
  const p = panel(t, init => {
    if (init.method === 'POST') applied = JSON.parse(init.body).action === 'install'
    return { ok: true, status: 200, json: async () => ({ ok: true, hostPatch: {
      surface: 'web', status: applied ? 'applied' : 'absent', canInstall: !applied, canRestore: applied, restartRequired: !applied,
    } }) }
  })
  let tree = await p.mount()
  await elements(tree).find(n => n.props?.key === 'install').props.onClick()
  assert.match(text(p.render()), /hostPatch.reload/)
  await elements(p.render()).find(n => n.props?.key === 'restore').props.onClick()
  assert.match(text(p.render()), /hostPatch.restart/)
  assert.deepEqual(p.calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body)), [{ action: 'install' }, { action: 'restore' }])
})

test('Web patch guidance survives module remounts before and after both action replies, but not a page reload', async t => {
  for (const timing of ['before', 'during']) await t.test(timing, async t => {
    const storage = new Map()
    for (const [key, value] of Object.entries({ window: new EventTarget(), sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    } })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key)
      Object.defineProperty(globalThis, key, { configurable: true, value })
      t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key] })
    }
    let applied = false
    for (const action of ['install', 'restore']) {
      let complete
      const reply = new Promise(resolve => { complete = resolve })
      const answer = init => {
        if (init.method === 'POST') applied = action === 'install'
        return { ok: true, status: 200, json: async () => {
          if (init.method === 'POST') await reply
          return { ok: true, hostPatch: { surface: 'web', status: applied ? 'applied' : 'absent',
            canInstall: !applied, canRestore: applied, restartRequired: false } }
        } }
      }
      const old = panel(t, answer)
      const tree = await old.mount()
      const pending = elements(tree).find(n => n.props?.key === action).props.onClick()
      if (timing === 'before') { complete(); await pending }
      old.unmount()
      const replacement = panel(t, answer)
      await replacement.mount()
      if (timing === 'during') { complete(); await pending }
      assert.match(text(replacement.render()), /hostPatch.reload/)
      replacement.unmount()
    }
    for (const [key, value] of storage) storage.set(key, JSON.stringify({ ...JSON.parse(value), page: -1 }))
    const reloaded = panel(t, () => ({ ok: true, status: 200, json: async () => ({ ok: true,
      hostPatch: { surface: 'web', status: 'absent', canInstall: true, canRestore: false } }) }))
    assert.doesNotMatch(text(await reloaded.mount()), /hostPatch.reload/)
  })
})

test('a failed Web patch action does not publish successful reload guidance', async t => {
  const p = panel(t, init => ({ ok: init.method !== 'POST', status: init.method === 'POST' ? 409 : 200,
    json: async () => ({ ok: init.method !== 'POST', error: 'file changed', hostPatch: {
      surface: 'web', status: 'absent', canInstall: true, canRestore: false } }) }))
  await elements(await p.mount()).find(n => n.props?.key === 'install').props.onClick()
  assert.match(text(p.render()), /file changed/)
  assert.doesNotMatch(text(p.render()), /hostPatch.reload|hostPatch.restart/)
})

test('Web settings hide older/desktop hosts and show disabled reasons and errors without breaking the panel', async t => {
  for (const mode of ['older', 'desktop', 'readonly', 'failed']) {
    await t.test(mode, async t => {
      const p = panel(t, () => {
        if (mode === 'failed') throw new Error('status unavailable')
        return { ok: mode !== 'older', status: mode === 'older' ? 404 : 200,
        json: async () => ({ ok: true, hostPatch: { surface: mode === 'desktop' ? 'desktop' : 'web', status: 'absent',
          canInstall: false, canRestore: false, reason: 'package not writable' } }) }
      })
      const tree = await p.mount()
      if (mode === 'older' || mode === 'desktop') assert.equal(tree, null)
      else {
        assert.match(text(tree), mode === 'failed' ? /status unavailable/ : /package not writable/)
        assert.ok(elements(tree).filter(n => n.type === 'button').every(n => n.props.disabled))
      }
    })
  }
})
