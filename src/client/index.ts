/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { apply as applyReference } from './reference/client/plugin.ts'
import { applySettingsSection } from './settings/index.ts'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createBrowserInitializationReader } from './browser/initialization.ts'
import type { BrowserInitializationReader } from './browser/initialization.ts'
import { createIframePage } from './pages.ts'
import { createReferenceCapture, type ReferenceCaptureContext } from './reference-capture-owner.ts'
import { createElectronPage } from './electron/pages.ts'
import { createNativePage } from './electron/NativeViewPage.ts'
import type { DesktopBrowserBridge, SidebarNativeSlot } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, BROWSER_KIND, browserDefinition } from './definition.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { StartPageBinding } from './startpage/binding.ts'
import { openShortcutTarget } from './shortcut-open.ts'
import { StartPageController } from './startpage/controller.ts'
import { BROWSER_STARTPAGE_NAMESPACE } from '../startpage-settings.ts'
import type { BrowserStartPagePreferences } from '../startpage-settings.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read initialization receipts for one exact Session/tab/document request. */
    sidebarBrowserInitialization: BrowserInitializationReader
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap {
    /** One start-page shortcut card; the originating tab owns the menu. */
    shortcut: {
      readonly sessionId: BrowserBodyProps['sessionId']
      readonly tabId: TabId
      readonly title: string
      readonly url: string
    }
  }
}

/** Required Browser services. */
// 引用坞（划选→浮条→输入栏胶囊）与侧栏标签同属这一个包，客户端入口把两者一起注册。
// uiConversation 是引用坞需要的会话面服务。
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiConversation']

/** Register the Browser type, localized guide entry, body, and title. */
/** sessionStorage 键：本页加载时看到的客户端产物版本。 */
const CLIENT_VERSION_WATCH = 'dsh-builtin-browser:client-version'

/**
 * 客户端产物是宿主启动时合成的整包脚本，URL 里的 rev 在启动那一刻固定：产物更新后浏览器仍按旧
 * URL 命中缓存，于是「改了代码界面不变」。这里轮询宿主暴露的产物指纹，一旦变化就带新参数重载本页
 * ——客户端改动不再需要重启宿主或手动破缓存。
 * @param ctx - 插件容器（用于随插件卸载停下轮询）。
 */
function watchClientVersion(ctx: Context): void {
  const check = async (): Promise<void> => {
    try {
      const response = await fetch('/dsh-builtin-browser/client-version', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return
      const body = await response.json() as { readonly version?: string }
      const version = body.version
      if (typeof version !== 'string' || version === '' || version === 'unknown') return
      const seen = sessionStorage.getItem(CLIENT_VERSION_WATCH)
      if (seen === null) { sessionStorage.setItem(CLIENT_VERSION_WATCH, version); return }
      if (seen === version) return
      sessionStorage.setItem(CLIENT_VERSION_WATCH, version)
      const url = new URL(location.href)
      url.searchParams.set('v', version)
      location.replace(url.toString())
    } catch {
      // 下一次轮询再试：这条通道失败不该影响界面。
    }
  }
  void check()
  const timer = setInterval(() => { void check() }, 60_000)
  ctx.effect(() => () => { clearInterval(timer) }, 'dsh-builtin-browser: client version watch')
}

export function apply(ctx: Context): void {
  // 先挂客户端自更新：产物一变，本页自己换到新 bundle（否则会一直用缓存里的旧脚本）。
  watchClientVersion(ctx)
  // 先装引用坞：它是输入栏那一侧的注册，与侧栏标签互不依赖。
  // 每个注册各自隔离：一个失败只丢一块能力，不能把同一 apply 里的其余注册一起掐断。
  try { applyReference(ctx as never) } catch (error) { console.warn('[dsh-builtin-browser] reference dock failed to mount', error) }
  // 再装设置页分节：旧插件的设置面板（宿主 /dsh-builtin-browser/settings 的 UI）。
  applySettingsSection(ctx)

  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const startPage = new StartPageBinding()
  const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
  const initializationListeners = new Set<() => void>()
  ctx.provide('sidebarBrowserInitialization')
  ctx.set('sidebarBrowserInitialization', createBrowserInitializationReader((sessionId, tabId) => {
    return controllers.get(sessionId as BrowserBodyProps['sessionId'])?.initialization(tabId)
  }, listener => {
    initializationListeners.add(listener)
    return () => { initializationListeners.delete(listener) }
  }, (sessionId, tabId) => controllers.get(sessionId as BrowserBodyProps['sessionId'])?.currentPage(tabId),
  (sessionId, tabId, url) => controllers.get(sessionId as BrowserBodyProps['sessionId'])?.loadUrl(tabId, url).ok === true))
  ctx.inject(['shortcuts'], (scope) => {
    scope.effect(() => scope.shortcuts.register({
      id: 'browser.address' as ShortcutCommandId, label: () => t('address.focus'), aliases: ['address bar', 'focus address'],
      defaults: {
        'desktop:macos': { code: 'KeyL', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyL', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyL', modifiers: ['primary'] },
        'web:macos': { code: 'KeyL', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyL', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        const face = target === undefined || target.tabId === undefined ? undefined : controllers.get(target.sessionId)
        if (target === undefined || target.tabId === undefined || face === undefined || !face.canFocusAddress(target.tabId)) {
          return { status: 'blocked', reason: t('address.focus.blocked') }
        }
        return { status: 'handled', run: () => { face.focusAddress(target.tabId!) } }
      },
    }), 'ui-sidebar-browser: address shortcut')
  })
  ctx.inject(['contextMenus'], (scope) => {
    scope.effect(() => scope.contextMenus.register({
      id: 'sidebar-browser.shortcut', target: 'shortcut', order: 20,
      resolve: ({ sessionId, tabId, url }) => [
        {
          id: 'open', label: t('startpage.open'),
          run: () => {
            openShortcutTarget(
              u => scope.sidebarRight.navigateTabIn<'browser'>(sessionId, tabId, { params: { url: u } }),
              u => { scope.sidebarRight.openTabIn<'browser'>(sessionId, BROWSER_KIND, { params: { url: u }, revealIfOpened: false }) },
              url,
            )
          },
        },
        {
          id: 'open-new-tab', label: t('startpage.openNewTab'),
          run: () => { scope.sidebarRight.openTabIn<'browser'>(sessionId, BROWSER_KIND, { params: { url }, revealIfOpened: false }) },
        },
      ],
    }), 'ui-sidebar-browser: shortcut menu')
    scope.effect(() => scope.contextMenus.register({
      id: 'sidebar-browser.tab.shortcut', target: 'tab', order: 90,
      resolve: (target) => {
        if (target.tab.kind !== BROWSER_KIND) return []
        const face = controllers.get(target.sessionId)
        const info = face?.pageInfo(target.tab.id)
        if (face === undefined || info === undefined) return []
        const title = target.tab.title.trim()
        return [{
          id: 'add-shortcut', label: t('startpage.addFromPage'), separatorBefore: true,
          run: () => {
            face.requestShortcut(target.tab.id, { url: info.url, title: title === '' ? info.title : title })
            // The form lives in the tab's body; reveal it before asking for input.
            scope.sidebarRight.focus(target.tab.id)
          },
        }]
      },
    }), 'ui-sidebar-browser: tab shortcut menu')
  })
  ctx.inject(['configForms'], (scope) => {
    scope.effect(() => {
      const controller = new StartPageController(
        scope.configForms.get<BrowserStartPagePreferences>(BROWSER_STARTPAGE_NAMESPACE),
        { applicationOrigin: window.location.origin },
      )
      const detach = startPage.attach(controller)
      return () => { detach(); controller.dispose() }
    }, 'ui-sidebar-browser: start-page preferences')
  })
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  ctx.effect(() => ctx.locale.register(namespace, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId), startPage,
          { sessionId, onInitializationChange: () => { for (const listener of initializationListeners) listener() } })
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'dsh-builtin-browser: reference capture')
  const capture = createReferenceCapture(ctx as unknown as ReferenceCaptureContext, lifetime.signal)
  if (desktop === undefined) {
    installFrames(ctx, sessionId => options => createIframePage(options, sessionId, capture))
  }
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => {
      const native = desktop.nativeViews
      const workspace = (signal: AbortSignal): Promise<string> => browserWorkspace(scope.workspaces.list, sessionId, signal)
      if (native?.protocolVersion === 1) {
        const sidebar = scope.sidebarRight as typeof scope.sidebarRight & {
          nativeSlot?: (session: typeof sessionId, tab: TabId, address: string, viewport: string, signal: AbortSignal) => Promise<SidebarNativeSlot>
        }
        return createNativePage(options, native, async (tab, address, viewport, signal) => {
          if (sidebar.nativeSlot === undefined) throw Object.assign(new Error('BROWSER_NATIVE_SURFACE_UNAVAILABLE'), { code: 'BROWSER_NATIVE_SURFACE_UNAVAILABLE' })
          return sidebar.nativeSlot(sessionId, tab, address, viewport, signal)
        }, workspace, sessionId)
      }
      return createElectronPage(options, desktop, workspace, sessionId, capture)
    })
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
