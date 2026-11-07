/**
 * Compatibility for historical automatic-install settings and explicit bridge-maintenance intent.
 * Runtime automatic installation is disabled. Bridge maintenance requires the user to close DSH
 * Desktop before explicitly running the installer; loading a plugin never changes the installation.
 * Historical marker readers remain available for diagnostics.
 * @module dsh-browser/browser-electron/bridge-auto
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BridgeStatus } from './bridge-status.js'
import type { BrowserChannel } from './system-browser.js'
import { writeFileAtomic } from './settings-store.js'

/** What the last automatic attempt was, and for which desktop build. */
export interface AutoInstallMarker {
  /** Desktop build the attempt belonged to (`version` from the identity check when known). */
  readonly build: string
  /** ISO timestamp of the attempt, recorded BEFORE running, so a crash still counts. */
  readonly attemptedAt: string
  /** Outcome recorded afterwards, for the panel and for support: `started` / `installed` / a reason. */
  readonly outcome: string
}

/** Everything the decision needs, so it can be tested without a filesystem or a shell. */
export interface AutoInstallInput {
  /** The launcher's current profile name, rather than an installed Desktop found on disk. */
  readonly profile: string | undefined
  /** Only sidebar and automatic selection need the desktop bridge. */
  readonly channel: BrowserChannel
  /** Quiet mode preserves the current desktop session instead of restarting it implicitly. */
  readonly quiet: boolean
  /** The desktop install directory, or undefined when this is the web end. */
  readonly installRoot: string | undefined
  /** Whether the operator left automatic installation on. */
  readonly enabled: boolean
  /** The reading the panel would show. */
  readonly status: BridgeStatus
  /** The last attempt, when one is recorded. */
  readonly marker: AutoInstallMarker | undefined
  /** How long an attempt for the same build suppresses the next one. */
  readonly cooldownMs: number
  /** Current time, injected. */
  readonly now: number
}

/** Why the automatic install did or did not run, in words a log line can carry. */
export interface AutoInstallDecision {
  /** Whether to start the installer now. */
  readonly run: boolean
  /** The reason, either way. */
  readonly why: string
}

/** Historical attempt-record interval, retained for compatibility with existing diagnostics. */
export const AUTO_INSTALL_COOLDOWN_MS = 24 * 60 * 60 * 1_000

/**
 * Report that runtime bridge installation is deferred to explicit maintenance.
 *
 * @param input - the readings described by {@link AutoInstallInput}.
 * @returns whether to run, and why.
 */
export function autoInstallDecision(_input: AutoInstallInput): AutoInstallDecision {
  return { run: false, why: 'runtime automatic bridge installation is disabled; close DSH Desktop and run bridge maintenance explicitly' }
}

/**
 * Read the profile identity supplied by DSH's launcher before plugins mount.
 * A Desktop installation or Electron executable can also belong to a Web/CLI invocation,
 * so neither is used to infer the current surface.
 * @param ctx - plugin context; older or custom compositions may omit the profile service.
 * @returns the current profile name, or undefined when the launcher did not provide it.
 */
export function readAutoInstallProfile(ctx: unknown): string | undefined {
  try {
    const context = ctx as { get?: (name: string) => unknown }
    if (typeof context?.get !== 'function') return undefined
    const profile = context.get('profileContext') as { name?: unknown } | undefined
    return typeof profile?.name === 'string' ? profile.name : undefined
  } catch {
    return undefined
  }
}

/** A manual uninstall could not record the operator's automatic-install opt-out. */
export class BridgeAutoInstallPreferenceError extends Error {
  constructor(cause: unknown) {
    super(`could not save automatic bridge installation preference: ${String(cause)}`, { cause })
    this.name = 'BridgeAutoInstallPreferenceError'
  }
}

/**
 * Preserve an explicit uninstall as an automatic-install opt-out in historical settings.
 * The preference is written before the installer starts, so a failed write cannot launch maintenance.
 * A failed uninstall retains the opt-out; an explicit install leaves an existing opt-out unchanged.
 * @param action - the authenticated user's selected action.
 * @param update - persist the operator's bridge preference.
 * @param run - perform the installer action after its preference is durable.
 * @returns the installer's result.
 */
export async function runWithManualBridgePreference<T>(
  action: 'install' | 'uninstall',
  update: (patch: { readonly bridge: { readonly autoInstall: false } }) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (action === 'uninstall') {
    try { update({ bridge: { autoInstall: false } }) }
    catch (error) { throw new BridgeAutoInstallPreferenceError(error) }
  }
  return await run()
}

/** Where the attempt record lives, beside the settings the plugin already owns. */
export function autoInstallMarkerPath(dshHome: string): string {
  return join(dshHome, 'dsh-builtin-browser-host', 'bridge-auto-install.json')
}

/**
 * Read the last attempt.
 *
 * A record that cannot be parsed is treated as absent: the guard exists to prevent loops, and a single
 * extra attempt after a corrupt file is cheaper than refusing to ever install again.
 * @param path - marker file path.
 * @returns the marker, or undefined.
 */
export function readAutoInstallMarker(path: string): AutoInstallMarker | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutoInstallMarker>
    if (typeof parsed.build !== 'string' || typeof parsed.attemptedAt !== 'string') return undefined
    return {
      build: parsed.build,
      attemptedAt: parsed.attemptedAt,
      outcome: typeof parsed.outcome === 'string' ? parsed.outcome : 'unknown',
    }
  } catch {
    return undefined
  }
}

/**
 * Record an attempt. Written before the installer runs: if the shell is killed mid-install, the next
 * launch must still see that an attempt happened rather than starting another restart.
 * @param path - marker file path.
 * @param marker - what to record.
 * @returns whether the record was saved; callers skip automatic restarts without a durable guard.
 */
export function writeAutoInstallMarker(path: string, marker: AutoInstallMarker): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, `${JSON.stringify(marker, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
