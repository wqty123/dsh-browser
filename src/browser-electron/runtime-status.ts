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
 * Everything here is a cheap read by construction. `hasBinary` resolves a path (the same probe a
 * launch uses, so the answer can never disagree with a launch), and the bridge reading is the same
 * install-tree inspection the bridge-status route already serves. Nothing spawns anything.
 * @module dsh-browser/browser-electron/runtime-status
 */
import type { BridgeStatus } from './bridge-status.js'
import type { BridgeEndpointState } from './bridge-endpoint.js'
import type { ProvisionSnapshot } from './electron-provision.js'
import type { BrowserChannel } from './system-browser.js'

/** The part of the carrier the channel names, in the terms the panel has to explain. */
export type CarrierKind = 'sidebar' | 'bundled' | 'system' | 'auto'

/**
 * Whether the readiness question has an answer at all.
 *
 * `unknown` is not a defect: an explicit Chrome / Edge choice is only falsifiable by launching one,
 * and launching a browser to answer a status question is exactly what this report must not do. The
 * panel says so in words instead of guessing a colour.
 */
export type Readiness = 'ready' | 'blocked' | 'unknown'

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
  /** What the settings document says, verbatim: the panel shows the switch it is honouring. */
  readonly channel: BrowserChannel
  /** What that channel resolves to, in panel terms. */
  readonly carrier: CarrierKind
  /** Whether the browser this channel names can serve a call right now. */
  readonly readiness: Readiness
  readonly electron: ElectronReadiness
  readonly bridge: BridgeReadiness
  /** Whether "Prepare the bundled browser" is worth offering (it is not while one is running). */
  readonly canProvision: boolean
}

/** Everything the report reads, so a test can answer without any of the real machinery. */
export interface RuntimeStatusDeps {
  /** The stored `browser.channel`. */
  readonly channel: () => BrowserChannel
  /** Whether a launch would find an Electron binary — the launch path's own probe. */
  readonly hasBinary: () => boolean
  /** The provisioning state machine's current state. */
  readonly provision: () => ProvisionSnapshot
  /** The desktop install's bridge state, or undefined when there is no desktop install. */
  readonly bridge: () => BridgeStatus | undefined
  /** The endpoint the shell publishes while it runs; undefined when nothing published one. */
  readonly endpoint: () => BridgeEndpointState | undefined
}

/** Which carrier a channel names. */
function carrierOf(channel: BrowserChannel): CarrierKind {
  if (channel === 'sidebar') return 'sidebar'
  if (channel === 'bundled') return 'bundled'
  if (channel === 'auto') return 'auto'
  return 'system'
}

/** Whether a binary being present settles the Electron question. */
function electronReady(state: ElectronReadiness['state']): boolean {
  return state === 'present' || state === 'ready'
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
  const carrier = carrierOf(channel)

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
  const bridge: BridgeReadiness = bridgeStatus === undefined
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
    }

  // The sidebar needs BOTH halves: our patch inside the shell it will be driven through, and that
  // shell actually running. Either one alone is the false green this report exists to prevent.
  const sidebarReady = bridge.state === 'installed' && bridge.running

  let readiness: Readiness
  if (carrier === 'sidebar') {
    readiness = sidebarReady ? 'ready' : 'blocked'
  } else if (carrier === 'bundled') {
    readiness = electronReady(state) ? 'ready' : 'blocked'
  } else if (carrier === 'auto') {
    // `auto` is satisfied by either carrier, so a working sidebar covers a missing runtime. An
    // explicit Chrome / Edge install would satisfy it too, but proving that means launching one.
    readiness = electronReady(state) || sidebarReady ? 'ready' : 'unknown'
  } else {
    readiness = 'unknown'
  }

  return {
    channel,
    carrier,
    readiness,
    electron,
    bridge,
    // Offering the button while a download runs would be a second download, which is the one thing
    // the shared attempt exists to prevent.
    canProvision: !electronReady(state) && state !== 'preparing',
  }
}
