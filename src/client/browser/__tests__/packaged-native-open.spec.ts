import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import vm from 'node:vm'
import { resolve } from 'node:path'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Dockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const external = new Map<string, unknown>([
  ['react', React], ['react/jsx-runtime', jsx], ['react-dom', ReactDOM], ['react-dom/client', ReactDOMClient], ['zod', { z }],
  ['@deepseek-ai/dsh-client-store', Store], ['@deepseek-ai/dsh-client-ui-dockkit', Dockkit],
  ['@deepseek-ai/dsh-client-ui-primitives', Primitives],
])

function load(source: string) {
  let factory: ((require: (id: string) => unknown) => any) | undefined
  const previous = (window as any).__ModuleLoader__
  ;(window as any).__ModuleLoader__ = { load: (entry: any) => { factory = entry.factory } }
  try { vm.runInThisContext(source, { filename: 'packaged-client.js' }) }
  finally { (window as any).__ModuleLoader__ = previous }
  if (factory === undefined) throw new Error('Client bundle did not register a factory')
  return factory(id => {
    if (!external.has(id)) throw new Error(`Unprovided client external: ${id}`)
    return external.get(id)
  })
}

afterEach(() => {
  vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear()
  document.head.querySelectorAll('style[data-plugin="dsh-builtin-browser"]').forEach(style => style.remove())
})

async function boot(pluginSource: string) {
  const registrations: any[] = [], disposers: (() => unknown)[] = [], injections: any[] = []
  const current = Store.createSnapshotStore({ key: 'session-packaged' })
  const pages = new Map<string, { url: string; listener?: (state: object) => void }>()
  let serial = 0
  const native = {
    protocolVersion: 1, persistentSession: true,
    slots: { enter: async () => 'owner', leave: async () => {}, register: async () => 'slot', update: async () => {}, revoke: async () => {} },
    acquire: vi.fn(async () => { const lease = `lease-${++serial}`; pages.set(lease, { url: '' }); return { lease } }),
    attach: async () => {}, release: async (lease: string) => { pages.delete(lease) },
    onState: (lease: string, listener: (state: object) => void) => { pages.get(lease)!.listener = listener; return () => {} },
    command: async (lease: string, method: string, params: any) => {
      const page = pages.get(lease)!
      if (method === 'Page.navigate') {
        page.url = params.url
        queueMicrotask(() => page.listener?.({ stage: 'document', generation: lease, frameId: 'frame', loaderId: 'loader' }))
      }
      if (method === 'Runtime.evaluate') return { result: { value: params.expression === '({url:location.href,title:document.title})'
        ? { url: page.url, title: 'Native document' } : {} } }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{}] }
      return {}
    },
  }
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: { nativeViews: native } })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const noOp = () => () => {}
  const ctx: any = {
    effect(run: () => any) {
      const result = run()
      if (typeof result === 'function') { disposers.push(result); return result }
      if (result?.[Symbol.iterator]) for (const release of result) if (typeof release === 'function') disposers.push(release)
      return () => {}
    },
    inject(names: string[], run: (scope: any) => void) {
      const injection = { names, run, done: false }; injections.push(injection); sync()
    },
    provide() {}, set(name: string, value: any) { ctx[name] = value; sync() }, get(name: string) { return ctx[name] },
    reflect: { provide(name: string, value: any) { ctx[name] = value; sync(); return () => { delete ctx[name] } } },
    locale: { bind: () => (key: string) => key, register: noOp },
    slots: {
      inject: (_name: string, run: () => any) => ctx.effect(run),
      register: (spec: any, component: any) => { const entry = { ...spec, component }; registrations.push(entry); return () => {} },
      entriesOfSlot: (name: string) => registrations.filter(entry => entry.name === name), subscribe: noOp,
    },
    layout: { panelInfo: Store.createSnapshotStore({ activePanelId: null }), openRightbar() {}, closeRightbar() {} },
    uiSession: { adapter: { current } },
    sessions: { retain: () => ({ ready: Promise.resolve(), release() {} }) },
    resources: { pin() {} },
    shortcuts: { runtime: 'desktop', register: noOp, catalog: Store.createSnapshotStore([]), closeWindow: async () => {} },
    contextMenus: { register: noOp, active: Store.createSnapshotStore(null) },
    workspaces: { list: Store.createSnapshotStore({ phase: 'ready', items: [] }) },
  }
  function sync() {
    for (const injection of injections) {
      if (!injection.done && injection.names.every((name: string) => ctx[name] !== undefined)) {
        injection.done = true; injection.run(ctx)
      }
    }
  }
  const host = load(gunzipSync(readFileSync(resolve(root, 'tests/fixtures/dsh-host-patch/client.after.js.gz'))).toString())
  host.apply(ctx)
  const seat = registrations.find(entry => entry.name === 'rightbar.session')
  const surface = seat.store.create('session-packaged')
  surface.actions.open('session-packaged')
  const panel = document.createElement('div'); panel.id = 'native-root'; panel.dataset.sidebarRightSession = 'session-packaged'
  document.body.append(panel)
  registrations.find(entry => entry.name === 'rightbar').inject().mountNativeOwner('session-packaged', panel.id)
  load(pluginSource).apply(ctx)
  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab' && entry.key === '@deepseek-ai/dsh-client-ui-sidebar-browser')
  const browser = body.inject('session-packaged', body.store.create('session-packaged').actions)
  const mounted = new Map<string, { abort: AbortController; revision: number }>()
  const render = () => {
    for (const tab of ctx.sidebarRight.tabsIn('session-packaged')) {
      if (tab.kind !== 'browser') continue
      const occurrence = ctx.sidebarRight.tabDomain.occurrence('session-packaged', tab)
      const navigation = occurrence.navigation.getSnapshot()
      const held = mounted.get(tab.id)
      if (held !== undefined) {
        if (held.revision !== navigation.revision) {
          held.revision = navigation.revision
          browser.navigate(tab.id, { url: navigation.params?.url ?? '', navigationRevision: navigation.revision })
        }
        continue
      }
      const viewport = document.createElement('div'); viewport.id = tab.id; panel.append(viewport)
      const abort = new AbortController(); mounted.set(tab.id, { abort, revision: navigation.revision })
      browser.mount({ tabId: tab.id, signal: abort.signal, viewportId: tab.id, applicationOrigin: 'http://localhost',
        initial: undefined, initialUrl: navigation.params?.url, navigationRevision: navigation.revision, openTab() {} })
    }
  }
  const stop = surface.subscribe(() => queueMicrotask(render))
  return {
    ctx, native, browser, api: (globalThis as any).__dshBuiltinBrowser, render,
    async dispose() {
      stop(); for (const { abort } of mounted.values()) abort.abort()
      await browser.dispose()
      for (const dispose of disposers.reverse()) await dispose()
      delete (globalThis as any).__dshBuiltinBrowser
    },
  }
}

function pluginBundle() {
  const archive = process.env.DSH_BROWSER_TEST_ARCHIVE
  return archive === undefined ? readFileSync(resolve(root, 'dist/client.cjs'), 'utf8')
    : execFileSync('tar', ['-xOf', archive, 'package/dist/client.cjs'], { encoding: 'utf8', maxBuffer: 4_000_000 })
}

it('opens native documents through the shipped plugin and rc.3 sidebar bundles, including retries and independent views', async () => {
  const h = await boot(pluginBundle())
  try {
    expect(h.ctx.sidebarRightTabs.get('browser').multiple).toBe(false)
    const styles = Array.from(document.head.querySelectorAll('style[data-plugin="dsh-builtin-browser"]'))
    expect(styles.map(style => style.getAttribute('data-plugin-css'))).toEqual(expect.arrayContaining([
      'dsh-builtin-browser/Browser.module.css', 'dsh-builtin-browser/ReferenceDock.module.css',
    ]))
    expect(styles.map(style => style.textContent).join('\n')).toMatch(/height:38px/)
    const results = []
    for (const [viewId, url] of [['first', 'https://example.test/one'], ['first', 'https://example.test/one'], ['retry', 'https://example.test/two']]) {
      const result = await h.api.initializePanel('session-packaged', url, { viewId, deadline: Date.now() + 1500 })
      results.push({ result, url })
    }
    for (const [index, { result, url }] of results.entries()) {
      expect(result, JSON.stringify(results)).toMatchObject({ ok: true, url, nativeState: { frameId: 'frame', loaderId: 'loader' } })
      if (index !== 1) expect(result.initialization).toMatchObject({ stage: 'attached' })
    }
    expect(results[1].result.tabId).toBe(results[0].result.tabId)
    expect(h.native.acquire).toHaveBeenCalledTimes(2)
    expect(h.ctx.sidebarRight.tabsIn('session-packaged').filter((tab: any) => tab.kind === 'browser')).toHaveLength(2)
    expect(document.querySelectorAll('webview')).toHaveLength(0)
  } finally { await h.dispose() }
})

it('rejects missing view identities before creating a native tab', async () => {
  const h = await boot(pluginBundle())
  try {
    expect(await h.api.initializePanel('session-packaged', '', { viewId: '', deadline: Date.now() + 1500 }))
      .toMatchObject({ ok: false, code: 'panel-initialization-failed' })
    expect(h.ctx.sidebarRight.tabsIn('session-packaged')).toHaveLength(0)
    expect(h.native.acquire).not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('closes a failed native initialization and admits a subsequent retry', async () => {
  const h = await boot(pluginBundle())
  try {
    h.native.acquire.mockRejectedValueOnce(new Error('native acquisition refused'))
    expect(await h.api.initializePanel('session-packaged', 'https://example.test/fail', { viewId: 'retry', deadline: Date.now() + 1500 }))
      .toMatchObject({ ok: false })
    expect(h.ctx.sidebarRight.tabsIn('session-packaged')).toHaveLength(0)
    expect(await h.api.initializePanel('session-packaged', 'https://example.test/retry', { viewId: 'retry', deadline: Date.now() + 1500 }))
      .toMatchObject({ ok: true, url: 'https://example.test/retry', initialization: { stage: 'attached' } })
    expect(h.ctx.sidebarRight.tabsIn('session-packaged')).toHaveLength(1)
  } finally { await h.dispose() }
})
