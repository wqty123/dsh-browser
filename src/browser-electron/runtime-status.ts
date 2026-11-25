/**
 * One answer to "can I use the browser right now", assembled from the three things that decide it.
 *
 * WHY THIS EXISTS
 * Installing this plugin made the browser work with no setup, and that property got silently
 * weaker as the carriers were added: the bundled carrier downloads a ~100 MB Electron runtime on
 * first need (issue #41 — the download had to leave `postinstall`), so on a fresh install the first
 * browser call can arrive while that download is still running, and the only trace anywhere in the
 * product was a log line the settings panel cannot read. A user who saw "cannot locate a spawnable
 * Electron binary" had no way to learn that the plugin was already fetching one, and no button to
 * retry it once it failed.
 *
 * So the readiness of each part is computed ONCE here, in a pure function over injectable readers:
 * the settings panel renders it, and a test drives it without touching Electron, a desktop install
 * or the file system.
 *
 * Everything here is a cheap environment check. The launch path's own binary probes resolve the
 * bundled runtime and installed system browsers; bridge readers inspect the installation and its
 * published endpoint. Available files establish availability, while browser calls establish whether
 * a particular page can be driven. Nothing spawns anything.
 * @module dsh-browser/browser-electron/runtime-status
 */
import type { BridgeStatus } from './bridge-status.ts'
import type { DesktopShellReport } from './desktop-shell.ts'
import type { BridgeEndpointState } from './bridge-endpoint.ts'
import type { ProvisionSnapshot } from './electron-provision.ts'
import type { ExtensionConnectionStatus } from '../../native-host/client.mjs'
import type { extensionInstallHelp } from './extension-browser.ts'
import { detectBrowser, type BrowserChannel, type DetectedBrowser, type SystemBrowserLaunchDiagnostic } from './system-browser.ts'

/** The part of the carrier the channel names, in the terms the panel has to explain. */
export type CarrierKind = 'sidebar' | 'bundled' | 'system' | 'extension' | 'cdp' | 'auto'

/** Whether the chosen carrier's required files or running bridge are available. */
export type Readiness = 'ready' | 'blocked'

/** The system-browser discovery result, obtained without launching an executable. */
export interface SystemBrowserReadiness {
  readonly launch?: SystemBrowserLaunchDiagnostic
  /** False for channels that use the sidebar or bundled runtime directly. */
  readonly checked: boolean
  readonly present: boolean
  readonly kind?: DetectedBrowser['kind']
  readonly path?: string
  /** What was found or which configured product is missing. */
  readonly detail: string
}

/** The Electron runtime's state, as the panel needs it. */
export interface ElectronReadiness {
  /** `present` — a launch would find a binary; `preparing` — a download is running now; and so on. */
  readonly state: ProvisionSnapshot['state']
  /** One line, already user-facing: the provisioning module's own words. */
  readonly detail: string
  /** When that state was reached, ISO. */
  readonly at: string
}

/** The desktop sidebar bridge, or the honest "there is no desktop here" shape. */
export interface BridgeReadiness {
  readonly mainExtension?: BridgeStatus['mainExtension']
  readonly code?: string
  /** Whether a DSH Desktop install was found at all. */
  readonly present: boolean
  /** `absent` is reported separately from `missing`: nothing to repair versus something to repair. */
  readonly state: BridgeStatus['state'] | 'absent'
  /** The plugin's own words about the install tree. */
  readonly detail: string
  /**
   * Whether a shell is RUNNING and answering, as opposed to merely installed.
   *
   * Install-tree state survives a reboot and says nothing about a process; the published endpoint is
   * the only thing that does. Reporting "installed" as "ready" is how a panel goes green while every
   * call dials a port nobody owns — the desktop app being closed is the most common broken state
   * there is.
   */
  readonly running: boolean
  /** The plugin's own words about the running shell (or about why there is none). */
  readonly runningDetail: string
  /** The command that installs or repairs it, for a human to run. Never run by the plugin. */
  readonly command?: string
}

/** The whole report. */
export interface RuntimeStatusReport {
  readonly nativeHostRegistration?: Record<string, { registered: boolean; detail: string }>
  readonly controlledProfile: 'plugin' | 'user' | 'sidebar'
  readonly extension?: ExtensionConnectionStatus & { readonly install?: ReturnType<typeof extensionInstallHelp>; readonly registration?: { registered: boolean; detail: string } }
  readonly fallbackReason?: string
  /** What the settings document says, verbatim: the panel shows the switch it is honouring. */
  readonly channel: BrowserChannel
  /** What that channel resolves to, in panel terms. */
  readonly carrier: CarrierKind
  /** The concrete carrier selected by the same discovery priority as the browser provider. */
  readonly resolvedCarrier: Exclude<CarrierKind, 'auto'>
  /** Whether the carrier's environment requirements are available. */
  readonly readiness: Readiness
  readonly systemBrowser: SystemBrowserReadiness
  /** The system executable selected for the resolved carrier, when applicable. */
  readonly executable?: string
  readonly electron: ElectronReadiness
  readonly bridge: BridgeReadiness
  /** The desktop shell found on this machine; only a patchable one gets bridge install / repair. */
  readonly shell?: DesktopShellReport
  /** Whether "Prepare the bundled browser" is worth offering (it is not while one is running). */
  readonly canProvision: boolean
}

/** Everything the report reads, so a test can answer without any of the real machinery. */
export interface RuntimeStatusDeps {
  readonly nativeHostRegistration?: () => NonNullable<RuntimeStatusReport['nativeHostRegistration']>
  readonly fallbackReason?: () => string | undefined
  readonly systemProfile?: () => 'user' | 'plugin'
  readonly extensionConnection?: () => RuntimeStatusReport['extension']
  /** The stored `browser.channel`. */
  readonly channel: () => BrowserChannel
  /** Whether a launch would find an Electron binary — the launch path's own probe. */
  readonly hasBinary: () => boolean
  /** The provisioning state machine's current state. */
  readonly provision: () => ProvisionSnapshot
  /** The desktop install's bridge state, or undefined when there is no desktop install. */
  readonly bridge: () => BridgeStatus | undefined
  readonly bridgeError?: () => string | undefined
  /** The desktop shell classification; omitted by hosts that only report the bridge. */
  readonly shell?: () => DesktopShellReport
  /** The endpoint the shell publishes while it runs; undefined when nothing published one. */
  readonly endpoint: () => BridgeEndpointState | undefined
  /** The launch path's filesystem-only browser discovery; defaults to the production reader. */
  readonly detectBrowser?: (channel: BrowserChannel) => DetectedBrowser | undefined
  /** The provider's current carrier, including a fallback selected after sidebar loss. */
  readonly selectedCarrier?: () => Exclude<CarrierKind, 'auto'> | undefined
  readonly systemConnection?: () => { connected: boolean; detail: string; launch?: SystemBrowserLaunchDiagnostic } | undefined
}

/** Which carrier a channel names. */
function carrierOf(channel: BrowserChannel): CarrierKind {
  if (channel === 'chrome' || channel === 'edge') return 'system'
  if (channel === 'electron') return 'bundled'
  return 'sidebar'
}

/**
 * Assemble the report.
 *
 * The `readiness` field is per carrier on purpose: "the browser is ready" is not a property of this
 * plugin, it is a property of the carrier the user chose. A bundled carrier with a finished download
 * is ready; the sidebar carrier with no bridge is not, however healthy the bundled runtime is.
 * @param deps - the readers; every one of them is a cheap, side-effect-free read.
 * @returns the report the panel renders.
 */
export function readRuntimeStatus(deps: RuntimeStatusDeps): RuntimeStatusReport {
  const channel = deps.channel()
  const preferExtension = (channel === 'edge' || channel === 'chrome') && deps.systemProfile?.() === 'user'
  const carrier = preferExtension ? 'extension' : carrierOf(channel)
  const extension = carrier === 'extension' ? deps.extensionConnection?.() ?? {
    state: 'extension-missing' as const, connected: false, browser: channel as 'edge' | 'chrome', detail: 'Optional extension is not connected; managed CDP is available as fallback.',
  } : undefined

  // The binary check comes first and wins: a runtime that is on disk is ready whatever the
  // provisioning state machine last said, which is also how a runtime installed by hand (or by an
  // earlier process) is reported correctly without a restart. The DETAIL has to follow the same
  // rule, or the panel shows "present" next to "the runtime has not been asked for yet" — measured
  // on a live install, and the kind of contradiction a reader cannot resolve.
  const snapshot = deps.provision()
  const runnable = deps.hasBinary()
  const missingAfterReady = !runnable && (snapshot.state === 'present' || snapshot.state === 'ready')
  const state: ElectronReadiness['state'] = runnable ? 'present' : missingAfterReady ? 'failed' : snapshot.state
  const electron: ElectronReadiness = {
    state,
    detail: runnable ? 'an Electron runtime is already available'
      : missingAfterReady ? 'the previously prepared Electron runtime is missing; prepare it again' : snapshot.detail,
    at: runnable ? new Date().toISOString() : snapshot.at,
  }

  const bridgeStatus = deps.bridge()
  const endpoint = deps.endpoint()
  const installedBridge: BridgeReadiness = bridgeStatus === undefined
    ? {
      present: false,
      state: 'absent',
      detail: 'no DSH Desktop install was found on this machine',
      running: endpoint?.alive === true,
      runningDetail: endpoint?.detail ?? 'no desktop shell has published a bridge endpoint',
    }
    : {
      present: bridgeStatus.present,
      state: bridgeStatus.state,
      detail: bridgeStatus.detail,
      running: endpoint?.alive === true,
      runningDetail: endpoint?.detail ?? 'no desktop shell has published a bridge endpoint',
      ...bridgeStatus.command === undefined ? {} : { command: bridgeStatus.command },
      ...bridgeStatus.mainExtension === undefined ? {} : { mainExtension: bridgeStatus.mainExtension },
      ...bridgeStatus.code === undefined ? {} : { code: bridgeStatus.code },
    }

  const bridgeError = deps.bridgeError?.()
  const bridge: BridgeReadiness = bridgeError === undefined ? installedBridge
    : { ...installedBridge, state: 'stale', detail: bridgeError }

  // The sidebar needs BOTH halves: our patch inside the shell it will be driven through, and that
  // shell actually running. Either one alone is the false green this report exists to prevent.
  // On DSH Tauri the patch is the host patch, which starts the same bridge inside electron-rs.
  const shell = deps.shell?.()
  const sidebarReady = bridge.running && (bridge.state === 'installed'
    || (shell?.kind === 'tauri' && shell.running === true && shell.hostPatch?.status === 'applied'))

  const selected = preferExtension ? deps.selectedCarrier?.() ?? (extension?.connected ? 'extension' : 'cdp') : undefined
  const checkSystemBrowser = carrier === 'system' || selected === 'cdp'
  const detected = checkSystemBrowser ? (deps.detectBrowser ?? detectBrowser)(channel) : undefined
  const connection = checkSystemBrowser ? deps.systemConnection?.() : undefined
  const systemBrowser: SystemBrowserReadiness = {
    ...connection?.launch === undefined ? {} : { launch: connection.launch },
    checked: checkSystemBrowser,
    present: detected !== undefined,
    ...detected === undefined ? {} : { kind: detected.kind, path: detected.path },
    detail: detected !== undefined ? connection?.detail ?? 'Browser has not launched; run a browser command to establish CDP. No live CDP connection.'
      : !checkSystemBrowser ? `the ${carrier} channel uses its own carrier`
        : `the selected ${channel} installation was not found`,
  }

  let readiness: Readiness
  let resolvedCarrier: RuntimeStatusReport['resolvedCarrier']
  if (carrier === 'bundled') {
    resolvedCarrier = 'bundled'
    readiness = runnable ? 'ready' : 'blocked'
  } else if (carrier === 'sidebar') {
    resolvedCarrier = 'sidebar'
    readiness = sidebarReady ? 'ready' : 'blocked'
  } else if (selected === 'cdp') {
    resolvedCarrier = 'cdp'
    readiness = detected !== undefined && connection?.connected === true ? 'ready' : 'blocked'
  } else if (carrier === 'extension') {
    resolvedCarrier = 'extension'
    readiness = extension?.state === 'connected' && extension.connected ? 'ready' : 'blocked'
  } else {
    resolvedCarrier = 'system'
    readiness = detected !== undefined && connection?.connected === true ? 'ready' : 'blocked'
  }

  return {
    ...deps.nativeHostRegistration ? { nativeHostRegistration: deps.nativeHostRegistration() } : {},
    controlledProfile: resolvedCarrier === 'extension' ? 'user' : resolvedCarrier === 'system' || resolvedCarrier === 'cdp' || resolvedCarrier === 'bundled' ? 'plugin' : 'sidebar',
    ...(preferExtension && resolvedCarrier === 'cdp' ? { fallbackReason: deps.fallbackReason?.() ?? (extension?.state === 'disabled' ? 'disabled' : 'not-connected') } : {}),
    ...extension === undefined ? {} : { extension },
    channel,
    carrier,
    resolvedCarrier,
    readiness,
    systemBrowser,
    ...resolvedCarrier === 'system' && detected !== undefined ? { executable: detected.path } : {},
    electron,
    bridge,
    ...shell === undefined ? {} : { shell },
    canProvision: resolvedCarrier === 'bundled' && !runnable && snapshot.state !== 'preparing',
  }
}
