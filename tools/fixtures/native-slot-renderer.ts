import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Dockkit from '@deepseek-ai/dsh-client-ui-dockkit'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { z } from 'zod'

const external = new Map<string, unknown>([
  ['react', React], ['react/jsx-runtime', jsx], ['react-dom', ReactDOM], ['react-dom/client', ReactDOMClient], ['zod', { z }],
  ['@deepseek-ai/dsh-client-store', Store], ['@deepseek-ai/dsh-client-ui-dockkit', Dockkit],
  ['@deepseek-ai/dsh-client-ui-primitives', Primitives],
])

function load(source: string) {
  let factory: (require: (id: string) => unknown) => any
  ;(window as any).__ModuleLoader__ = { load: (entry: any) => { factory = entry.factory } }
  ;(0, eval)(source)
  return factory!(id => {
    if (!external.has(id)) throw new Error(`Unprovided client external: ${id}`)
    return external.get(id)
  })
}

;(window as any).bootNativeSlot = (hostSource: string, pluginSource: string, alreadyOpen: boolean) => {
  const registrations: any[] = [], injections: any[] = []
  const current = Store.createSnapshotStore({ key: 'session-packaged' })
  const noOp = () => () => {}
  const ctx: any = {
    effect(run: () => any) {
      const result = run()
      if (result?.[Symbol.iterator]) for (const release of result) void release
      return typeof result === 'function' ? result : () => {}
    },
    inject(names: string[], run: (scope: any) => void) { injections.push({ names, run, done: false }); sync() },
    provide() {}, set(name: string, value: any) { ctx[name] = value; sync() }, get(name: string) { return ctx[name] },
    reflect: { provide(name: string, value: any) { ctx[name] = value; sync(); return () => { delete ctx[name] } } },
    locale: { bind: () => (key: string) => key, register: noOp },
    slots: {
      inject: (_name: string, run: () => any) => ctx.effect(run),
      register: (spec: any, component: any) => { registrations.push({ ...spec, component }); return () => {} },
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
  load(hostSource).apply(ctx)
  const seat = registrations.find(entry => entry.name === 'rightbar.session')
  const surface = seat.store.create('session-packaged')
  surface.actions.open('session-packaged')
  const panel = document.createElement('div')
  panel.id = 'native-root'; panel.dataset.sidebarRightSession = 'session-packaged'
  const hostCss = Array.from(document.querySelectorAll('style[data-plugin="@deepseek-ai/dsh-client-ui-sidebar-right"]')).map(style => style.textContent).join('\n')
  const prefix = hostCss.match(/\.([\w-]+)_panel\{/)?.[1]
  if (!prefix) throw new Error('The packaged sidebar panel stylesheet is absent')
  panel.className = `${prefix}_panel`
  if (alreadyOpen) panel.dataset.sidebarRightOpen = ''
  panel.style.cssText = 'position:fixed;left:400px;top:80px;width:550px;height:520px;--dsh-sidebar-width:550px;--ds-transition-duration-slow:250ms;--ds-ease-in-out:linear'
  const dock = document.createElement('div')
  dock.dataset.dockkitHost = 'dock'; dock.style.cssText = 'position:absolute;inset:0;background:#fff'
  panel.append(dock); document.body.append(panel)
  registrations.find(entry => entry.name === 'rightbar').inject().mountNativeOwner('session-packaged', panel.id)
  load(pluginSource).apply(ctx)
  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab' && entry.key === 'dsh-builtin-browser')
  const browser = body.inject('session-packaged', body.store.create('session-packaged').actions)
  const mounted = new Map<string, number>()
  const render = () => {
    for (const tab of ctx.sidebarRight.tabsIn('session-packaged')) {
      if (tab.kind !== 'browser') continue
      const navigation = ctx.sidebarRight.tabDomain.occurrence('session-packaged', tab).navigation.getSnapshot()
      if (mounted.has(tab.id)) {
        if (mounted.get(tab.id) !== navigation.revision) {
          mounted.set(tab.id, navigation.revision)
          browser.navigate(tab.id, { url: navigation.params?.url ?? '', navigationRevision: navigation.revision })
        }
        continue
      }
      const viewport = document.createElement('div'); viewport.id = tab.id
      viewport.dataset.nativeTestViewport = ''; viewport.style.cssText = 'position:absolute;inset:38px 0 0'
      dock.append(viewport); mounted.set(tab.id, navigation.revision)
      browser.mount({ tabId: tab.id, signal: new AbortController().signal, viewportId: tab.id, applicationOrigin: location.origin,
        initial: undefined, initialUrl: navigation.params?.url, navigationRevision: navigation.revision, openTab() {} })
      requestAnimationFrame(() => requestAnimationFrame(() => { panel.dataset.sidebarRightOpen = '' }))
    }
  }
  surface.subscribe(() => queueMicrotask(render))
  ;(window as any).slotGeometry = () => {
    const viewport = document.querySelector<HTMLElement>('[data-native-test-viewport]')!
    const rect = viewport.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: getComputedStyle(viewport).visibility, scale: devicePixelRatio }
  }
}
