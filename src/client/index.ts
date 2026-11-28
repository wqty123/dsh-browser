import { CLIENT_VERSION_ROUTE } from '../../assets/browser-policy.mjs'
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
import { NativeChildPresentation } from './electron/NativeChildPresentation.ts'
import type { DesktopBrowserBridge, SidebarNativeSlot } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import { desktopBrowserBridge, nativeChildTabs, nativeViews } from '../compat/host-features.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, BROWSER_KIND, browserDefinition } from './definition.tsx'
import { en, ja, es, fr, de, ru, pt, zh, SIDEBAR_BROWSER_LOCALE_NS } from './locales.ts'
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
// 寮曠敤鍧烇紙鍒掗€夆啋娴潯鈫掕緭鍏ユ爮鑳跺泭锛変笌渚ф爮鏍囩鍚屽睘杩欎竴涓寘锛屽鎴风鍏ュ彛鎶婁袱鑰呬竴璧锋敞鍐屻€?
// uiConversation 鏄紩鐢ㄥ潪闇€瑕佺殑浼氳瘽闈㈡湇鍔°€?
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiConversation']

/** Register the Browser type, localized guide entry, body, and title. */
/** sessionStorage 閿細鏈〉鍔犺浇鏃剁湅鍒扮殑瀹㈡埛绔骇鐗╃増鏈€?*/
const CLIENT_VERSION_WATCH = 'dsh-builtin-browser:client-version'

type SidebarHostExtensions = {
  navigateTabIn?: (session: BrowserBodyProps['sessionId'], tab: TabId, options: { params: { url: string } }) => boolean
  openReservedTab?: (session: BrowserBodyProps['sessionId'], kind: string, tab: TabId) => boolean
}

function registerShortcutIfAbsent(
  register: () => () => void,
): () => void {
  try {
    return register()
  } catch (error) {
    // When DSH's built-in ui-sidebar-browser is also enabled (issue #107), it already registers
    // built-in shortcut commands; skip cleanly rather than aborting plugin apply.
    if (/Duplicate shortcut command|Conflicting shortcut defaults/i.test(String(error))) return () => {}
    throw error
  }
}

/**
 * 瀹㈡埛绔骇鐗╂槸瀹夸富鍚姩鏃跺悎鎴愮殑鏁村寘鑴氭湰锛孶RL 閲岀殑 rev 鍦ㄥ惎鍔ㄩ偅涓€鍒诲浐瀹氾細浜х墿鏇存柊鍚庢祻瑙堝櫒浠嶆寜鏃?
 * URL 鍛戒腑缂撳瓨锛屼簬鏄€屾敼浜嗕唬鐮佺晫闈笉鍙樸€嶃€傝繖閲岃疆璇㈠涓绘毚闇茬殑浜х墿鎸囩汗锛屼竴鏃﹀彉鍖栧氨甯︽柊鍙傛暟閲嶈浇鏈〉
 * 鈥斺€斿鎴风鏀瑰姩涓嶅啀闇€瑕侀噸鍚涓绘垨鎵嬪姩鐮寸紦瀛樸€?
 * @param ctx - 鎻掍欢瀹瑰櫒锛堢敤浜庨殢鎻掍欢鍗歌浇鍋滀笅杞锛夈€?
 */
function watchClientVersion(ctx: Context): void {
  const check = async (): Promise<void> => {
    try {
      const response = await fetch(CLIENT_VERSION_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return
      const body = await response.json() as { readonly version?: string }
      const version = body.version
      if (typeof version !== 'string' || version === '' || version === 'unknown') return
      const reload = (token: string): void => {
        const url = new URL(location.href)
        url.searchParams.set('v', token)
        location.replace(url.toString())
      }
      const seen = sessionStorage.getItem(CLIENT_VERSION_WATCH)
      // The first check of a page that was opened BEFORE a deploy must not adopt the deployed token
      // as "seen": the page is still running the old bundle. The deployed token is kept in
      // localStorage precisely so the next tab (or the next load) notices it and reloads once.
      if (seen === null) {
        const deployed = localStorage.getItem(CLIENT_VERSION_WATCH)
        sessionStorage.setItem(CLIENT_VERSION_WATCH, version)
        localStorage.setItem(CLIENT_VERSION_WATCH, version)
        if (deployed !== null && deployed !== version) { reload(version); return }
        return
      }
      if (seen === version) return
      sessionStorage.setItem(CLIENT_VERSION_WATCH, version)
      localStorage.setItem(CLIENT_VERSION_WATCH, version)
      reload(version)
      location.replace(url.toString())
    } catch {
      // 涓嬩竴娆¤疆璇㈠啀璇曪細杩欐潯閫氶亾澶辫触涓嶈褰卞搷鐣岄潰銆?
    }
  }
  void check()
  // A deploy replaces lib/client.js, so the served token (mtime-size) changes. Checking only
  // every minute left a deploy unseen until a poll happened to land; re-checking on focus and on
  // the tab becoming visible is what makes it feel like a dev server's hot reload.
  const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void check() }, 15_000)
  const onVisible = (): void => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void check() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  if (typeof window !== 'undefined') window.addEventListener('focus', onVisible)
  ctx.effect(() => () => {
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible)
  }, 'dsh-builtin-browser: client version watch')
}


/** Register the Browser tab type. */
export function apply(ctx: Context): void {
  // 鍏堟寕瀹㈡埛绔嚜鏇存柊锛氫骇鐗╀竴鍙橈紝鏈〉鑷繁鎹㈠埌鏂?bundle锛堝惁鍒欎細涓€鐩寸敤缂撳瓨閲岀殑鏃ц剼鏈級銆?
  // Isolated like the reference dock: an update watcher that cannot start must not take the whole
  // client registration with it (issue #132: one failing registration left the settings section
  // missing altogether).
  try { watchClientVersion(ctx) } catch (error) { console.warn('[dsh-builtin-browser] client version watch failed to start', error) }
  // 鍏堣寮曠敤鍧烇細瀹冩槸杈撳叆鏍忛偅涓€渚х殑娉ㄥ唽锛屼笌渚ф爮鏍囩浜掍笉渚濊禆銆?
  // 姣忎釜娉ㄥ唽鍚勮嚜闅旂锛氫竴涓け璐ュ彧涓竴鍧楄兘鍔涳紝涓嶈兘鎶婂悓涓€ apply 閲岀殑鍏朵綑娉ㄥ唽涓€璧锋帎鏂€?
  try { applyReference(ctx as never) } catch (error) { console.warn('[dsh-builtin-browser] reference dock failed to mount', error) }
  // 鍐嶈璁剧疆椤靛垎鑺傦細鏃ф彃浠剁殑璁剧疆闈㈡澘锛堝涓?/dsh-builtin-browser/settings 鐨?UI锛夈€?
  try { applySettingsSection(ctx) } catch (error) { console.warn('[dsh-builtin-browser] settings section failed to mount', error) }

  const namespace = SIDEBAR_BROWSER_LOCALE_NS
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => registerShortcutIfAbsent(() => ctx.shortcuts.register({
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
    })), 'ui-sidebar-browser: shortcut')
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
    scope.effect(() => registerShortcutIfAbsent(() => scope.shortcuts.register({
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
    })), 'ui-sidebar-browser: address shortcut')
  })
  ctx.inject(['contextMenus'], (scope) => {
    scope.effect(() => scope.contextMenus.register({
      id: 'dsh-builtin-browser.shortcut', target: 'shortcut', order: 20,
      resolve: ({ sessionId, tabId, url }) => [
        {
          id: 'open', label: t('startpage.open'),
          run: () => {
            openShortcutTarget(
              u => (scope.sidebarRight as typeof scope.sidebarRight & SidebarHostExtensions).navigateTabIn?.(sessionId, tabId, { params: { url: u } }) === true,
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
      id: 'dsh-builtin-browser.tab.shortcut', target: 'tab', order: 90,
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
  const desktop = desktopBrowserBridge()
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
    installFrames(scope, sessionId => {
      const childApi = nativeChildTabs(desktop)
      const sidebar = scope.sidebarRight as typeof scope.sidebarRight & SidebarHostExtensions
      const children = childApi !== undefined && sidebar.openReservedTab !== undefined ? new NativeChildPresentation(childApi, sessionId,
        tab => sidebar.openReservedTab?.(sessionId, BROWSER_KIND, tab) === true,
        tab => { sidebar.closeIn(sessionId, tab) }) : undefined
      return options => {
        const native = nativeViews(desktop)
        const workspace = (signal: AbortSignal): Promise<string> => browserWorkspace(scope.workspaces.list, sessionId, signal)
        if (native !== undefined) {
          const sidebar = scope.sidebarRight as typeof scope.sidebarRight & {
            nativeSlot?: (session: typeof sessionId, tab: TabId, address: string, viewport: string, signal: AbortSignal) => Promise<SidebarNativeSlot>
          }
          return createNativePage(options, native, async (tab, address, viewport, signal) => {
            if (sidebar.nativeSlot === undefined) throw Object.assign(new Error('BROWSER_NATIVE_SURFACE_UNAVAILABLE'), { code: 'BROWSER_NATIVE_SURFACE_UNAVAILABLE' })
            return sidebar.nativeSlot(sessionId, tab, address, viewport, signal)
          }, workspace, sessionId, capture, children)
        }
        return createElectronPage(options, desktop, workspace, sessionId, capture)
      }
    })
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
