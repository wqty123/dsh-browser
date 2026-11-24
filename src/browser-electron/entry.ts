import { referenceCaptureMessages, referenceCaptureErrors } from '../../assets/browser-messages.mjs'
import { BROWSER_PROFILE_DIR, SETTINGS_ROUTE, EXTENSION_INSTALL_ROUTE } from '../../assets/browser-policy.mjs'
/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects). When a desktop shell supplies
 * `ctx.electronViewHost`, that host is used (embedded, human-machine shared
 * view). Otherwise it requires a reconnectable sidebar carrier. Only explicitly
 * selected Chrome or Edge may launch an external browser.
 * @module dsh-browser/browser-electron
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from '../browser/runtime.ts'
import { ElectronBrowserProvider } from './provider.ts'
import { provisionElectronInBackground, provisionSnapshot, hasElectronRuntime } from './electron-provision.ts'
import type { ElectronBrowserViewHost } from './provider.ts'
import type { CarrierLossReason } from '../browser/types.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.ts'
import { setTimeout as wait } from 'node:timers/promises'
import { DesktopBridgeViewHost } from './desktop-bridge-host.ts'
import { SidebarOnlyHost } from './sidebar-only-host.ts'
import { ExtensionBrowserViewHost, extensionInstallHelp } from './extension-browser.ts'
import { PreferredBrowserViewHost } from './preferred-browser.ts'
import { nativeRegistration, installExtension, registrationStatus, probeExtension } from './extension-setup.ts'
import { registerCarrierTakeover } from '../browser/takeover-target.ts'
import { detectBrowser, searchSummary, SystemBrowserViewHost } from './system-browser.ts'
import { claimEphemeralProfile, ephemeralProfileName, sweepAbandonedEphemeralProfiles } from './ephemeral-profile.ts'
import { MissingSystemBrowserHost } from './missing-system-browser.ts'
import { SettingsStore, settingsPath } from './settings-store.ts'
import { sameOrigin } from './settings-route.ts'
import { authenticatedRoute, pairedRoute, isDirectLoopback, type BrowserConnection, type BrowserPairingConnection, type BrowserHttpHandler } from './authenticated-route.ts'
import { overlayScript } from '../browser-reference/entry.ts'
import { getLastOpen } from './open-slot.ts'
import { GUEST_ROUTE, handleGuest } from './guest-route.ts'
import { resolveSessionHandle, sessionWireId } from '../browser/handles.ts'
import { handleBridgeStatus, handlePreviewFrame, handlePreviewSessions, BRIDGE_STATUS_ROUTE, PREVIEW_ROUTE, PREVIEW_SESSIONS_ROUTE } from './preview-route.ts'
import { detectDesktopShell, findDesktopInstall, readBridgeStatus } from './bridge-status.ts'
import { publishTauriDesktopMain, runningTauriRuntime } from './tauri-host.ts'
import { readHostExtensionStatus } from './profile-extension.ts'
import { readBridgeEndpoint } from './bridge-endpoint.ts'
import { runBridgeAction } from './bridge-install.ts'
import { prepareBridgeMaintenance } from './bridge-maintenance.ts'
import { automaticMaintenanceSupported, commitAutomaticMaintenance, readAutomaticMaintenance, startAutomaticMaintenance } from './automatic-maintenance.ts'
import { AUTOMATIC_MAINTENANCE_ROUTE, createAutomaticMaintenanceHandler } from './maintenance-route.ts'
import { HOST_PATCH_ROUTE, createHostPatchMaintenance, servedClientModules } from './host-patch-maintenance.ts'
import { runWithManualBridgePreference } from './bridge-auto.ts'
import { replyJson, writeJsonText } from './json-reply.ts'
import { readJsonBody, readTextBody } from './http-body.ts'
import { readRuntimeStatus } from './runtime-status.ts'
import { handleRuntimeProvision, handleRuntimeStatus, RUNTIME_PROVISION_ROUTE, RUNTIME_STATUS_ROUTE } from './runtime-route.ts'
import { createShortcutRouteHandlers, SHORTCUT_ADD_ROUTE, SHORTCUT_REMOVE_ROUTE, SHORTCUTS_ROUTE } from './shortcuts-route.ts'
import { createShortcutStore, type ShortcutSettings } from './startpage-shortcuts.ts'
import { createReferenceService, setReferenceCaptureActionHandler } from '../browser-reference/service.ts'
import { WEB_SOURCE_ROUTE } from '../reference-source.ts'
import { createDeliveryQueue, resolveReferenceOwner, type DeliveryQueue } from '../browser-reference/delivery.ts'
import type { BrowserReference, BrowserReferenceCarrier } from '../browser-reference/types.ts'
import {
  createReferenceRouteHandlers,
  REFERENCE_CAPTURE_ROUTE,
  REFERENCE_EXPORT_ROUTE,
  REFERENCE_GET_ROUTE,
  REFERENCE_IMPORT_ROUTE,
  REFERENCE_INSERT_ROUTE,
  REFERENCE_LIST_ROUTE,
  REFERENCE_REVEAL_ROUTE,
  REFERENCE_DELIVERIES_ROUTE,
  REFERENCE_DELIVERY_ACK_ROUTE,
  REFERENCE_DELIVERY_REMOVE_ROUTE,
  REFERENCE_ASSET_ROUTE,
  CLIENT_VERSION_ROUTE,
  REFERENCE_STATUS_ROUTE,
} from './reference-route.ts'

function isPreferredCarrier(host: ElectronBrowserViewHost | undefined): host is ExtensionBrowserViewHost | PreferredBrowserViewHost {
  return host instanceof ExtensionBrowserViewHost || host instanceof PreferredBrowserViewHost
}

function overlayTag(): string {
  const source = overlayScript().replace(/<\/script/giu, '<\\/script')
  return `<script data-dsh-ref-overlay-src="guest">(function(){\n${source}\n})()</script>`
}

function readSurfaceForRoute(): 'panel' | 'builtin' {
  try {
    const fs = (process as unknown as { getBuiltinModule?: (id: string) => { readFileSync: (p: string, e: string) => string } }).getBuiltinModule?.('fs')
    if (fs === undefined) return 'panel'
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { browser?: { surface?: unknown } }
    return parsed.browser?.surface === 'builtin' ? 'builtin' : 'panel'
  } catch { return 'panel' }
}

export const OPEN_REQUEST_ROUTE = '/dsh-builtin-browser/browser/open-request'
const OPEN_REQUEST_TTL_MS = 10_000
export const SURFACE_DECL_ROUTE = '/dsh-builtin-browser/browser/declare-surface'

export {
  ELECTRON_BROWSER_PROVIDER_ID,
  ElectronBrowserProvider,
} from './provider.ts'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'

function carrierSettingsKey(settings: ReturnType<SettingsStore['get']>): string {
  return JSON.stringify([settings.browser.channel, settings.browser.systemProfile, settings.browser.headless,
    settings.browser.systemProfile === 'plugin' ? settings.cookies.persist : undefined])
}

export const name = 'browser-electron'
export const inject = ['browser']

export interface Config {
  readonly viewHost?: ElectronBrowserViewHost
  readonly httpOnly?: boolean
  readonly downloadDir?: string
  readonly snapshotMaxElements?: number
  readonly contentMaxChars?: number
}

export const Config: z<Config> = z.object({
  viewHost: z.any(),
  httpOnly: z.boolean().default(true),
  downloadDir: z.string(),
  snapshotMaxElements: z.number(),
  contentMaxChars: z.number(),
})

function readSessionId(ctx: unknown): string | undefined {
  try {
    const surface = ctx as { get?: (name: string) => unknown }
    if (typeof surface.get !== 'function') return undefined
    const agents = surface.get('agents') as { list?: () => unknown } | undefined
    const list = typeof agents?.list === 'function' ? agents.list() : undefined
    if (!Array.isArray(list) || list.length === 0) return undefined
    const first = list[0] as { id?: unknown } | undefined
    return typeof first?.id === 'string' && first.id !== '' ? first.id : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context & { browser: BrowserRuntime }, config: Config): void {
  if (runningTauriRuntime() !== undefined) {
    try { publishTauriDesktopMain() } catch (error) { ctx.logger?.warn?.(`dsh-builtin-browser: cannot name the sidebar bridge to DSH Tauri: ${String(error)}`) }
  }
  const sessionId = readSessionId(ctx)
  const settings = new SettingsStore(undefined, message => ctx.logger?.warn?.(message))

  let referenceProvider: ElectronBrowserProvider | undefined
  const trackProvider = (provider: ElectronBrowserProvider): ElectronBrowserProvider => {
    if (referenceProvider !== undefined && referenceProvider !== provider) referenceProvider.dispose()
    referenceProvider = provider
    return provider
  }
  const providerConfig = {
    referenceLabel: () => readSessionId(ctx),
    httpOnly: config.httpOnly,
    downloadDir: config.downloadDir,
    snapshotMaxElements: config.snapshotMaxElements,
    contentMaxChars: config.contentMaxChars,
    settings: () => settings.get(),
  }

  let panelOpening: Promise<{ host: DesktopBridgeViewHost; provider: ElectronBrowserProvider } | undefined> | undefined
  let panelsDisposed = false
  const retirePanel = (panel: { host: DesktopBridgeViewHost; provider: ElectronBrowserProvider }, lost = false): void => {
    panel.provider.dispose()
    void Promise.allSettled(panel.provider.watchableSessions().map(id => panel.provider.close(id)))
      .finally(() => {
        if (lost) setImmediate(() => { panel.host.dispose() })
        else panel.host.dispose()
      })
  }
  const unregisterPanel = ctx.browser.registerPanelProvider(async () => {
    const selected = settings.get().browser
    if ((selected.channel === 'edge' || selected.channel === 'chrome') && selected.systemProfile === 'user') {
      if (!isPreferredCarrier(adoptedCarrier) || !referenceProvider) throw new Error('Selected personal-browser carrier is unavailable; no sidebar fallback.')
      return referenceProvider
    }
    if (panelOpening === undefined) {
      const opening = (async () => {
        const host = await DesktopBridgeViewHost.discover(sessionId, () => settings.get().ui.quiet)
        if (host === undefined) return undefined
        if (panelsDisposed) { host.dispose(); return undefined }
        const provider = new ElectronBrowserProvider(host, providerConfig)
        const panel = { host, provider }
        host.onLost(() => {
          if (panelOpening === opening) panelOpening = undefined
          retirePanel(panel, true)
        })
        return panel
      })()
      panelOpening = opening
    }
    try {
      const panel = await panelOpening
      if (panel === undefined) panelOpening = undefined
      return panel?.provider
    } catch (error) {
      panelOpening = undefined
      throw error
    }
  })
  ctx.effect(() => () => {
    panelsDisposed = true
    unregisterPanel()
    void panelOpening?.then(panel => {
      if (panel === undefined) return
      retirePanel(panel)
    }).catch(() => {})
  })

  const reportCarrierLoss = (reason: CarrierLossReason): void => {
    const detail = reason === 'shell-exited'
      ? 'the desktop shell backed the sidebar browser and has exited'
      : 'the desktop shell is running, but its sidebar browser panel cannot be driven'
    ctx.logger?.warn?.(`dsh-builtin-browser: ${detail} (${reason}); the next operation requires the DSH sidebar. No standalone fallback will be opened.`)
  }
  const requiredSidebar = (): SidebarOnlyHost => {
    const host = new SidebarOnlyHost(async signal => {
      for (const pause of [0, 1_000, 3_000, 8_000]) {
        signal.throwIfAborted()
        if (pause > 0) await wait(pause, undefined, { signal })
        const sidebar = await DesktopBridgeViewHost.discover(sessionId, () => settings.get().ui.quiet)
        if (sidebar !== undefined) return sidebar
        if (DesktopBridgeViewHost.refusedIframePanel()) break
      }
      const detail = DesktopBridgeViewHost.refusedIframePanel()
        ? 'the DSH sidebar is an iframe and cannot support CDP tools'
        : 'no controllable DSH sidebar is available'
      throw Object.assign(new Error(`dsh-builtin-browser: ${detail}. Use a host-provided sidebar/webview carrier or install the DSH native-view host patch, then retry. The Web panel supports manual browsing, not CDP tools. No standalone browser will be opened.`), { code: 'BROWSER_NATIVE_SURFACE_UNAVAILABLE' })
    })
    host.onLost(reportCarrierLoss)
    return host
  }
  const initialHost = requiredSidebar()
  let unregister = ctx.browser.registerBrowserProvider(trackProvider(new ElectronBrowserProvider(initialHost, providerConfig)))
  let disposed = false
  let carrierChoice = 0
  let adoptedCarrier: ElectronBrowserViewHost | undefined = initialHost
  let unregisterTakeover = (): void => {}

  ctx.effect(() => () => {
    disposed = true
    unregisterTakeover()
    carrierChoice += 1
    unregister()
    referenceProvider?.dispose()
    if (adoptedCarrier !== config.viewHost) adoptedCarrier?.dispose?.()
  })

  const restoreSidebar = (adopted: ElectronBrowserViewHost, reason: CarrierLossReason): void => {
    if (disposed || adoptedCarrier !== adopted) return
    try {
      const restored = requiredSidebar()
      unregister()
      unregister = ctx.browser.registerBrowserProvider(trackProvider(new ElectronBrowserProvider(restored, providerConfig)))
      adoptedCarrier = restored
      reportCarrierLoss(reason)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-builtin-browser: could not restore the sidebar carrier: ${String(error)}`)
    } finally {
      setImmediate(() => {
        try {
          adopted.dispose?.()
        } catch {
          // A carrier that cannot be released is not the caller's problem; the swap already happened.
        }
      })
    }
  }

  const adopt = (host: ElectronBrowserViewHost, note: string, choice = carrierChoice): void => {
    if (disposed || choice !== carrierChoice) {
      try { host.dispose?.() } catch { /* a stale result must not escape its retry */ }
      return
    }
    const previous = adoptedCarrier
    try {
      unregister()
      unregister = ctx.browser.registerBrowserProvider(trackProvider(new ElectronBrowserProvider(host, providerConfig)))
      adoptedCarrier = host
      unregisterTakeover()
      if (isPreferredCarrier(host)) {
        const provider = referenceProvider!
        unregisterTakeover = registerCarrierTakeover(ctx.browser, owner => provider.takeoverTargets(owner).map(target => ({
          ...target, connected: () => adoptedCarrier === host && host.connectedView(target.tabId),
        })))
        void host.refreshStatus()
      } else if (host instanceof SystemBrowserViewHost) {
        const provider = referenceProvider!
        unregisterTakeover = registerCarrierTakeover(ctx.browser, owner => provider.takeoverTargets(owner).map(target => ({
          ...target,
          connected: () => adoptedCarrier === host && host.connectedView(target.tabId),
          unavailableReason: () => adoptedCarrier === host && host.headlessView(target.tabId)
            ? 'Browser takeover requires a visible browser window, but the current Chrome/Edge session is running headless. Switch browser.headless to windowed (or auto with a display) and retry.'
            : undefined,
        })), { exclusive: false })
      }
      ctx.logger?.info?.(`dsh-builtin-browser: ${note}`)
      if (!(host instanceof SidebarOnlyHost)) host.onLost?.(reason => { restoreSidebar(host, reason) })
      if (previous !== undefined && previous !== host && previous !== config.viewHost) {
        try { previous.dispose?.() } catch { /* the replacement is already serving */ }
      }
    } catch (error) {
      try { host.dispose?.() } catch { /* the fallback below matters more than this */ }
      if (isPreferredCarrier(host)) {
        ctx.logger?.warn?.(`dsh-builtin-browser: could not adopt the selected personal-browser extension (${String(error)}); no profile fallback`)
        return
      }
      try {
        const fallback = requiredSidebar()
        unregister = ctx.browser.registerBrowserProvider(trackProvider(new ElectronBrowserProvider(fallback, providerConfig)))
        adoptedCarrier = fallback
        if (previous !== undefined && previous !== host) {
          try { previous.dispose?.() } catch { /* fallback is already serving */ }
        }
        ctx.logger?.warn?.(`dsh-builtin-browser: could not adopt ${note} (${String(error)})`)
      } catch (fallbackError) {
        ctx.logger?.warn?.(
          `dsh-builtin-browser: could not adopt ${note} (${String(error)}), and the fallback `
          + `registration also failed (${String(fallbackError)}) — no browser provider is `
          + 'registered for this context')
      }
    }
  }

  let chosenSettingsKey = ''
  const chooseCarrier = (): void => {
  if (disposed) return
  chosenSettingsKey = carrierSettingsKey(settings.get())
  const choice = ++carrierChoice
  const channel = settings.get().browser.channel
  if (channel !== 'chrome' && channel !== 'edge') {
    if (config.viewHost !== undefined) {
      if (adoptedCarrier !== config.viewHost) adopt(config.viewHost as ElectronBrowserViewHost, 'using the composition-provided sidebar carrier', choice)
    } else if (!(adoptedCarrier instanceof SidebarOnlyHost)) adopt(requiredSidebar(), 'using only the selected DSH sidebar', choice)
    return
  }
    const detected = detectBrowser(channel)
    if (detected === undefined) {
        const missing = new MissingSystemBrowserHost(channel, searchSummary(channel))
        adopt(settings.get().browser.systemProfile === 'user' ? new PreferredBrowserViewHost(channel, missing) : missing,
          `the selected ${channel} is not installed — commands will explain how to fix it`)
    } else {
      const home = dshHome()
      const persist = settings.get().cookies.persist
      const profileRoot = join(home, BROWSER_PROFILE_DIR)
      adoptLegacyProfileRoot(profileRoot)
      const profileDir = persist
        ? join(profileRoot, `${detected.kind}-profile`)
        : join(profileRoot, ephemeralProfileName(detected.kind, randomUUID()))
      if (!persist) {
        sweepAbandonedEphemeralProfiles(profileRoot, detected.kind)
        claimEphemeralProfile(profileDir)
      }
      ;(globalThis as unknown as Record<string, unknown>).__dshBrowserCarrier = 'launched-plugin-profile'
      const managed = new SystemBrowserViewHost(detected, profileDir, [], !persist ? profileDir : undefined,
        undefined, settings.get().browser.headless, () => settings.get().ui.quiet,
        undefined, { managed: true })
      adopt(settings.get().browser.systemProfile === 'user' ? new PreferredBrowserViewHost(channel, managed) : managed,
        `will drive the installed ${detected.kind} (${detected.path}${persist ? '' : ', ephemeral profile'})`)
    }
  }

  chooseCarrier()
  void nativeRegistration.ensure().catch(() => {})

  function installPreviewRoute(ctx: Context, settings: SettingsStore): void {
    const injectPreview = (ctx as unknown as {
      inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
    }).inject
    if (typeof injectPreview !== 'function') return
    try {
      injectPreview(['webServer', 'browser'], (host) => {
        const browser = (ctx as unknown as { browser?: PreviewBrowser }).browser
        if (browser === undefined) return
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: PREVIEW_ROUTE,
          handler: paired(ctx, (request, response) => handlePreviewFrame(request, response, settings, browser)),
        }, 'dsh-builtin-browser: live view frame'))
  host.effect(() => host.webServer.register({
    kind: 'exact',
    path: SURFACE_DECL_ROUTE,
    handler: authenticated(ctx, (request, response) => {
      readJsonBody(request).then((body) => {
        const surface = body !== null && typeof body === 'object' && (body as { surface?: unknown }).surface
        if (surface === 'panel' || surface === 'builtin') {
          (globalThis as unknown as Record<string, unknown>).__dshBrowserSurface = surface
        }
        replyJson(response, 200, { ok: true })
      }).catch(() => { replyJson(response, 200, { ok: false }) })
    }),
  }, 'dsh-builtin-browser: surface declaration'))
  host.effect(() => host.webServer.register({
    kind: 'exact',
    path: OPEN_REQUEST_ROUTE,
    handler: authenticated(ctx, (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() === 'POST') {
        request.resume()
        request.on('end', () => { replyJson(response, 200, { ok: true, cleared: false }) })
        return
      }
      const last = getLastOpen()
      const fresh = last !== undefined && Date.now() - last.at <= OPEN_REQUEST_TTL_MS ? last : undefined
      replyJson(response, 200, { ok: true, surface: readSurfaceForRoute(), open: isPreferredCarrier(adoptedCarrier) ? null : fresh ?? null })
    }),
  }, 'dsh-builtin-browser: open request slot'))
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: PREVIEW_SESSIONS_ROUTE,
          handler: paired(ctx, (request, response) => handlePreviewSessions(request, response, settings, browser)),
        }, 'dsh-builtin-browser: live view sessions'))      })
    } catch {
      // No web server on this surface: watching is simply unavailable, and nothing else changes.
    }
  }

  const BRIDGE_ACTION_ROUTE = '/dsh-builtin-browser/bridge-action'
  let bridgeActionRunning = false

  async function handleBridgeAction(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') { replyJson(response, 405, { error: 'method-not-allowed' }); return }
    if (!sameOrigin(request, true)) { replyJson(response, 403, { error: 'not-same-origin' }); return }
    if (!isDirectLoopback(request)) { replyJson(response, 403, { error: 'local-request-required' }); return }
    let action: unknown
    let preparationOnly = false
    try {
      const input = await readJsonBody<{ action?: unknown; prepare?: unknown }>(request)
      action = input.action
      if (input.prepare !== undefined && typeof input.prepare !== 'boolean') throw new Error('prepare must be a boolean')
      preparationOnly = input.prepare === true
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    if (action !== 'install' && action !== 'uninstall') {
      replyJson(response, 400, { ok: false, error: 'action must be "install" or "uninstall"' })
      return
    }
    const root = findDesktopInstall()
    if (root === undefined) {
      const shell = detectDesktopShell({ preferredBrowser: settings.get().browser.channel })
      replyJson(response, 409, { ok: false, error: shell.kind === 'none' ? 'no DSH Desktop install was found on this machine' : `not patchable: ${shell.reason}`, shell })
      return
    }
    if (bridgeActionRunning) {
      replyJson(response, 409, { ok: false, error: 'bridge-action-in-progress' })
      return
    }
    const active = readAutomaticMaintenance()
    if (!preparationOnly && active !== undefined && !['completed', 'failed', 'cancelled'].includes(active.phase)) {
      replyJson(response, 409, { ok: false, error: 'an automatic bridge maintenance job is in progress' })
      return
    }
    bridgeActionRunning = true
    try {
      if (preparationOnly) {
        const result = await prepareBridgeMaintenance(action, root)
        replyJson(response, 200, { ...result, action })
        return
      }
      const result = await runWithManualBridgePreference(action, patch => settings.update(patch), () => runBridgeAction(action, root))
      replyJson(response, 200, { ...result, action })
    } catch (error) {
      if (preparationOnly) {
        replyJson(response, 500, { ok: false, error: `could not prepare bridge maintenance: ${String(error)}` })
        return
      }
      replyJson(response, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
    } finally {
      bridgeActionRunning = false
    }
  }

  function installBridgeStatusRoute(ctx: Context): void {
    const injectStatus = (ctx as unknown as {
      inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
    }).inject
    if (typeof injectStatus !== 'function') return
    try {
      injectStatus(['webServer'], (host) => {
        const hostPatchMaintenance = createHostPatchMaintenance({
          modules: () => servedClientModules(ctx.get('clientModules')),
          desktop: () => process.versions.electron !== undefined,
          tauri: () => runningTauriRuntime()?.runtime,
        })
        host.effect(() => host.webServer.register({
          kind: 'exact', path: HOST_PATCH_ROUTE,
          handler: authenticated(ctx, hostPatchMaintenance),
        }, 'dsh-builtin-browser: Web host patch maintenance'))
        const automaticMaintenance = createAutomaticMaintenanceHandler({
          supported: () => automaticMaintenanceSupported(),
          quit: () => process.platform === 'win32' ? 'menu' : 'self',
          busy: () => bridgeActionRunning,
          read: () => readAutomaticMaintenance(),
          commit: async id => { await commitAutomaticMaintenance(id) },
          start: async (action, options) => {
            const root = findDesktopInstall()
            if (root === undefined) throw new Error(`no verified DSH Desktop installation was found: ${detectDesktopShell().reason}`)
            return await runWithManualBridgePreference('install', patch => settings.update(patch),
              async () => await startAutomaticMaintenance(action, root, options))
          },
        })
        host.effect(() => host.webServer.register({
          kind: 'exact', path: AUTOMATIC_MAINTENANCE_ROUTE,
          handler: authenticated(ctx, automaticMaintenance),
        }, 'dsh-builtin-browser: explicit automatic bridge maintenance'))
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: BRIDGE_STATUS_ROUTE,
          handler: authenticated(ctx, async (request, response) => handleBridgeStatus(request, response, undefined,
            await readHostExtensionStatus(dshHome()), undefined, undefined, settings.get().browser.channel)),
        }, 'dsh-builtin-browser: bridge status'))
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: BRIDGE_ACTION_ROUTE,
          handler: authenticated(ctx, (request, response) => handleBridgeAction(request, response)),
        }, 'dsh-builtin-browser: bridge action'))
      })
    } catch {
      // No web server: the panel is unreachable, and the installer stays the interface.
    }
  }

  installSettingsRoute(ctx, settings, () => { chooseCarrier() })

  function installRuntimeStatusRoute(ctx: Context, settings: SettingsStore): void {
    const injectRuntime = (ctx as unknown as {
      inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
    }).inject
    if (typeof injectRuntime !== 'function') return
    const deps = {
      report: async () => {
        const mainExtension = await readHostExtensionStatus(dshHome())
        return readRuntimeStatus({
          nativeHostRegistration: () => Object.fromEntries(registrationStatus),
          channel: () => settings.get().browser.channel,
          systemProfile: () => settings.get().browser.systemProfile,
          extensionConnection: () => isPreferredCarrier(adoptedCarrier) ? {
            ...adoptedCarrier.connectionStatus(), install: extensionInstallHelp(adoptedCarrier.browser), registration: registrationStatus.get(adoptedCarrier.browser),
          } : undefined,
          selectedCarrier: () => adoptedCarrier instanceof DesktopBridgeViewHost || adoptedCarrier instanceof SidebarOnlyHost ? 'sidebar'
            : adoptedCarrier instanceof PreferredBrowserViewHost ? adoptedCarrier.activeCarrier()
            : adoptedCarrier instanceof ExtensionBrowserViewHost ? 'extension' : adoptedCarrier instanceof SystemBrowserViewHost ? 'system' : 'bundled',
          fallbackReason: () => adoptedCarrier instanceof PreferredBrowserViewHost ? adoptedCarrier.fallbackReason : undefined,
          systemConnection: () => adoptedCarrier instanceof PreferredBrowserViewHost ? adoptedCarrier.fallback.connectionStatus?.() : adoptedCarrier instanceof SystemBrowserViewHost ? adoptedCarrier.connectionStatus() : undefined,
          hasBinary: hasElectronRuntime,
          provision: provisionSnapshot,
          bridgeError: () => DesktopBridgeViewHost.compatibilityError(),
          shell: () => detectDesktopShell({ preferredBrowser: settings.get().browser.channel }),
          bridge: () => {
            const root = findDesktopInstall()
            return root === undefined ? undefined : readBridgeStatus(root, mainExtension)
          },
          endpoint: () => readBridgeEndpoint(),
        })
      },
      provision: () => {
        void provisionElectronInBackground(
          message => ctx.logger?.info?.(`dsh-builtin-browser: ${message}`),
          undefined,
          { force: true },
        )
        return provisionSnapshot()
      },
    }
    try {
      injectRuntime(['webServer'], (host) => {
        host.effect(() => host.webServer.register({ kind: 'exact', path: EXTENSION_INSTALL_ROUTE, handler: authenticated(ctx, async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          if (!sameOrigin(request, true)) { response.writeHead(403); response.end(); return }
          try {
            const browser = settings.get().browser.channel === 'chrome' ? 'chrome' : 'edge'
            if (isPreferredCarrier(adoptedCarrier)) await adoptedCarrier.refreshStatus()
            const connected = isPreferredCarrier(adoptedCarrier) ? adoptedCarrier.connectionStatus().connected : await probeExtension(browser)
            const result = await installExtension(browser, connected)
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
          } catch (error) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: false, detail: String(error) })) }
        }) }, 'dsh-builtin-browser: install extension'))
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: RUNTIME_STATUS_ROUTE,
          handler: authenticated(ctx, async (request, response) => {
            if (request.method === 'GET' && isPreferredCarrier(adoptedCarrier)) await adoptedCarrier.refreshStatus()
            await handleRuntimeStatus(request, response, deps)
          }),
        }, 'dsh-builtin-browser: runtime status'))
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: RUNTIME_PROVISION_ROUTE,
          handler: authenticated(ctx, (request, response) => handleRuntimeProvision(request, response, deps)),
        }, 'dsh-builtin-browser: runtime provision'))
      })
    } catch {
      // No web server: the panel is unreachable, and the readiness report has no reader.
    }
  }

  function installShortcutRoutes(host: Context): void {
    const injectRoutes = (host as unknown as {
      inject?: (deps: readonly string[], callback: (scope: WebServerHost) => void) => void
    }).inject
    if (typeof injectRoutes !== 'function') return
    const store = createShortcutStore(() => (host as unknown as {
      get?: (name: string) => ShortcutSettings | undefined
    }).get?.('settings'))
    const handlers = createShortcutRouteHandlers(store)
    try {
      injectRoutes(['webServer'], (scope) => {
        const routes: readonly (readonly [string, BrowserHttpHandler, string])[] = [
          [SHORTCUTS_ROUTE, handlers.list, 'dsh-builtin-browser: start-page shortcuts'],
          [SHORTCUT_ADD_ROUTE, handlers.add, 'dsh-builtin-browser: start-page shortcut add'],
          [SHORTCUT_REMOVE_ROUTE, handlers.remove, 'dsh-builtin-browser: start-page shortcut remove'],
        ]
        for (const [path, handler, label] of routes) {
          scope.effect(() => scope.webServer.register({
            kind: 'exact',
            path,
            handler: authenticated(host, handler),
          }, label))
        }
      })
    } catch {
      // No web server: the shortcut seam stays available to the agent tool.
    }
  }

  function installReferenceRoutes(
    ctx: Context,
    service: ReturnType<typeof createReferenceService>,
    carrier: () => BrowserReferenceCarrier,
    queue: DeliveryQueue,
  ): void {
    const injectRoutes = (ctx as unknown as {
      inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
    }).inject
    if (typeof injectRoutes !== 'function') return
    try {
      injectRoutes(['webServer'], (host) => {
        const handlers = createReferenceRouteHandlers({ service, carrier, queue })
        const routes: readonly (readonly [string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, string])[] = [
          [CLIENT_VERSION_ROUTE, (_request, response) => {
            const clientPath = fileURLToPath(new URL('../../dist/client.cjs', import.meta.url))
            let version = "unknown"
            try {
              const stat = statSync(clientPath)
              version = `${Math.round(stat.mtimeMs)}-${stat.size}`
            } catch { /* 读不到就返回 unknown：客户端不会重载 */ }
            response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
            response.end(JSON.stringify({ ok: true, version }))
          }, 'dsh-builtin-browser: client version'],
          [REFERENCE_LIST_ROUTE, handlers.list, 'dsh-builtin-browser: reference list'],
          [REFERENCE_GET_ROUTE, handlers.get, 'dsh-builtin-browser: reference detail'],
          [REFERENCE_CAPTURE_ROUTE, handlers.capture, 'dsh-builtin-browser: reference capture'],
          [REFERENCE_REVEAL_ROUTE, handlers.reveal, 'dsh-builtin-browser: reference reveal'],
          [WEB_SOURCE_ROUTE, handlers.source, 'dsh-builtin-browser: web reference source'],
          [REFERENCE_INSERT_ROUTE, handlers.insert, 'dsh-builtin-browser: reference draft insert'],
          [REFERENCE_EXPORT_ROUTE, handlers.export, 'dsh-builtin-browser: reference export'],
          [REFERENCE_IMPORT_ROUTE, handlers.importBundle, 'dsh-builtin-browser: reference import'],
          [REFERENCE_DELIVERIES_ROUTE, handlers.deliveries, 'dsh-builtin-browser: reference deliveries'],
          [REFERENCE_DELIVERY_ACK_ROUTE, handlers.ack, 'dsh-builtin-browser: reference delivery ack'],
          [REFERENCE_DELIVERY_REMOVE_ROUTE, handlers.removeDelivery, 'dsh-builtin-browser: reference delivery remove'],
          [REFERENCE_ASSET_ROUTE, handlers.asset, 'dsh-builtin-browser: reference asset bytes'],
        ]
        for (const [path, handler, label] of routes) {
          host.effect(() => host.webServer.register({
            kind: 'exact',
            path,
            handler: authenticated(ctx, handler),
          }, label))
        }
        host.effect(() => host.webServer.register({
          kind: 'exact',
          path: REFERENCE_STATUS_ROUTE,
          handler: authenticated(ctx, (request, response) => {
            if (request.method !== 'GET') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
            replyJson(response, 200, { ok: true, entry: referenceProvider?.referenceStatus() ?? null })
          }),
        }, 'dsh-builtin-browser: reference entry status'))
      })
    } catch {
      // No web server: capture stays available through the agent tools.
    }
  }

  const watchSettingsFile = (): void => {
    const file = settingsPath()
    let lastMtime = 0
    try { lastMtime = statSync(file).mtimeMs } catch { /* not written yet */ }
    const timer = setInterval(() => {
      if (disposed) { clearInterval(timer); return }
      let mtime = 0
      try { mtime = statSync(file).mtimeMs } catch { return }
      if (mtime === lastMtime) return
      lastMtime = mtime
      if (carrierSettingsKey(settings.get()) === chosenSettingsKey) return
      ctx.logger?.info?.('dsh-builtin-browser: carrier settings changed on disk, re-choosing the carrier')
      chooseCarrier()
    }, 5_000)
    timer.unref?.()
    ctx.effect(() => () => { clearInterval(timer) }, "dsh-builtin-browser: settings file watch")
  }
  watchSettingsFile()
  installPreviewRoute(ctx, settings)
  installBridgeStatusRoute(ctx)
  installRuntimeStatusRoute(ctx, settings)
  const referenceService = createReferenceService(ctx.browser, {
    sourceReady: async owner => { (await DesktopBridgeViewHost.discover(`session-${owner}`))?.dispose() },
    sourceSession: (owner, pageId) => ctx.browser.bindPanelPage(`session-${owner}`, pageId),
    visibleCapture: async (sessionId, clip, signal) => {
      const shot = await ctx.browser.screenshot(sessionWireId(resolveSessionHandle(sessionId)), { clip, format: 'png' }, signal)
      return { dataUrl: shot.dataUrl, mime: 'image/png' }
    },
  })
  const referenceCarrier = (): BrowserReferenceCarrier => {
    const channel = settings.get().browser.channel
    return channel === 'chrome' || channel === 'edge' ? channel : 'sidebar'
  }

  const deliveryQueue = createDeliveryQueue()
  installReferenceRoutes(ctx, referenceService, referenceCarrier, deliveryQueue)
  installShortcutRoutes(ctx)

  type PrepareFailure = 'browser-session-id-required' | 'delivery-enqueue-failed'

  const prepareCaptured = (
    reference: BrowserReference | undefined,
    failures: readonly { readonly kind: string; readonly reason: string }[],
    onFailure?: (code: PrepareFailure) => void,
  ): boolean => {
    if (reference === undefined) return false
    if ((reference.owner.sessionId ?? '').startsWith('browser:')) {
      process.stderr.write('[dsh-browser] reference delivery refused: browser-session-id-required\n')
      onFailure?.('browser-session-id-required')
      return false
    }
    try {
      deliveryQueue.prepare(reference, {
        failures: failures.map(failure => ({
          kind: (failure.kind === 'text' || failure.kind === 'image' || failure.kind === 'table'
            ? failure.kind : 'reference') as 'text' | 'image' | 'table' | 'reference',
          reason: failure.reason,
        })),
      })
      return true
    } catch (error) {
      process.stderr.write(`[dsh-browser] reference delivery prepare failed: ${String(error)}\n`)
      onFailure?.('delivery-enqueue-failed')
      return false
    }
  }

  referenceService.setDraftAdapter({
    insertReference: async (reference) => {
      const current = deliveryQueue.get(reference.referenceId)
      if (current?.state === 'removed') return { applied: false, reason: 'reference-was-removed' }
      if (current === undefined && !prepareCaptured(reference, [])) {
        return { applied: false, reason: 'delivery-enqueue-failed' }
      }
      return { applied: true }
    },
  })

  const captureRefusalText = (failures: readonly { readonly reason: string }[]): string => {
    const copy = referenceCaptureMessages
    for (const failure of failures) {
      const reason = failure.reason
      const exact = copy[reason]
      if (exact !== undefined) return exact
      if (reason.startsWith('capture-failed:')) return referenceCaptureErrors.captureFailed
      if (reason.startsWith('store-refused:')) return referenceCaptureErrors.storeRefused
      if (reason.startsWith('frame-capture-refused:')) return copy['frame-capture-refused']
      if (reason.startsWith('cell-image:')) return referenceCaptureErrors.imageUnreadable
      if (reason.startsWith('image-')) return referenceCaptureErrors.imageFailed
    }
    return copy['capture-refused']
  }

  const disposeReferenceAction = setReferenceCaptureActionHandler(async action => {
    const owner = resolveReferenceOwner(readSessionId(ctx) ?? sessionId, action.windowId)
    const outcome = await referenceService.capture({
      sessionId: owner.sessionId,
      browserSessionId: owner.browserSessionId,
      origin: 'user-selection',
      entry: action.entry,
      carrier: referenceCarrier(),
      ...action.frameSelector !== undefined ? { frameSelector: action.frameSelector } : {},
      ...action.target !== undefined ? { target: action.target } : {},
      ...action.comment !== undefined ? { comment: action.comment } : {},
      ...action.capture !== undefined
        ? { frozenCapture: action.capture }
        : action.selectionText !== undefined && action.selectionText !== ''
          ? { excerptText: action.selectionText }
          : {},
    })
    if (outcome.reference === undefined) {
      process.stderr.write(`[dsh-browser] reference capture refused: ${outcome.failures.map(item => item.reason).join(', ')}\n`)
      try {
        await referenceService.notify(owner.browserSessionId, captureRefusalText(outcome.failures))
      } catch {
        // Best effort
      }
      return
    }
    let prepareFailure: PrepareFailure = 'delivery-enqueue-failed'
    if (!prepareCaptured(outcome.reference, outcome.failures, code => { prepareFailure = code })) {
      try {
        await referenceService.notify(owner.browserSessionId,
          `当前会话还没准备好，请稍后重新添加这条引用。（错误码：${prepareFailure}）`)
      } catch {
        // Best effort
      }
    }
  })
  ctx.effect(() => disposeReferenceAction, 'dsh-builtin-browser: reference action handler')
  ctx.effect(() => () => deliveryQueue.dispose(), 'dsh-builtin-browser: reference delivery queue')
}

export function adoptLegacyProfileRoot(
  profileRoot: string,
  legacyRoot: string = join(homedir(), BROWSER_PROFILE_DIR),
): void {
  try {
    if (legacyRoot === profileRoot) return
    if (!existsSync(legacyRoot) || existsSync(profileRoot)) return
    mkdirSync(dirname(profileRoot), { recursive: true })
    renameSync(legacyRoot, profileRoot)
  } catch {
    // Nothing here is worth failing an apply over; the fallback is the pre-existing behaviour.
  }
}

interface PreviewBrowser {
  exists(session: string): boolean
  capturePassive(session: string, signal?: AbortSignal): Promise<{ readonly dataUrl: string }>
  watchableSessions?(): readonly string[]
}

function authenticated(ctx: Context, handler: BrowserHttpHandler): BrowserHttpHandler {
  return authenticatedRoute(() => {
    const surface = ctx as unknown as { get(name: string): BrowserConnection | undefined }
    return surface.get('connection')
  }, handler)
}

function paired(ctx: Context, handler: BrowserHttpHandler): BrowserHttpHandler {
  return pairedRoute(() => {
    const surface = ctx as unknown as { get(name: string): BrowserPairingConnection | undefined }
    return surface.get('connection')
  }, handler)
}

interface WebServerHost {
  readonly webServer: {
    register(
      spec: {
        readonly kind: 'exact'
        readonly path: string
        readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
      },
      label?: string,
    ): () => void
  }
  effect(callback: () => (() => void) | void): void
}

function installSettingsRoute(
  ctx: Context,
  settings: SettingsStore,
  onChannelChange?: () => void,
): void {
  const inject = (ctx as unknown as {
    inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
  }).inject
  if (typeof inject !== 'function') return
  try {
    inject(['webServer'], (host) => {
      host.effect(() => host.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: authenticated(ctx, (request, response) => handleSettingsRequest(request, response, settings, onChannelChange)),
      }, 'dsh-builtin-browser: settings'))
    })
  } catch {
    // No web server on this surface: the settings file remains the interface.
  }
}

async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settings: SettingsStore,
  onChannelChange?: () => void,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    writeJsonText(response, status, JSON.stringify(body), {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
  }
  const method = request.method ?? 'GET'
  if (!sameOrigin(request, method !== 'GET')) {
    json(403, { ok: false, error: 'cross-origin request refused' })
    return
  }
  if (method === 'GET') {
    json(200, { ok: true, settings: settings.get(), path: settings.path() })
    return
  }
  if (method !== 'PUT' && method !== 'POST') {
    response.writeHead(405, { allow: 'GET, PUT' })
    response.end()
    return
  }
  try {
    const text = await readTextBody(request)
    const patch: unknown = text.trim() === '' ? {} : JSON.parse(text)
    const before = carrierSettingsKey(settings.get())
    const updated = settings.update(patch)
    const carrierChanged = carrierSettingsKey(updated) !== before
    if (carrierChanged) onChannelChange?.()
    json(200, {
      ok: true,
      settings: updated,
      ...carrierChanged ? { carrierRechosen: true } : {},
    })
  } catch (error) {
    json(400, { ok: false, error: `invalid settings patch: ${String(error)}` })
  }
}
