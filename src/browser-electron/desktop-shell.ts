/**
 * What kind of desktop shell an install is, and what the user should do with it.
 *
 * The bridge patches exactly one shell: DeepSeek Harness Desktop with its `lib/main.js` entry. A
 * community shell that reuses the `dsh-desktop` package name (dataelement/dsh-desktop, issue #62)
 * is recognised as such and never patched; the report tells the settings page to hide bridge
 * install / repair and to point at the system browser first.
 * @module dsh-browser/browser-electron/desktop-shell
 */
import type { DesktopIdentity, IdentityRefusal } from './desktop-identity.ts'

export type DesktopShellKind = 'official-supported' | 'official-unsupported' | 'third-party-shell' | 'none'
export type RecommendedCarrier = 'sidebar' | 'chrome' | 'edge'

/** One desktop shell, classified. Only `official-supported` is ever `patchable`. */
export interface DesktopShellReport {
  readonly kind: DesktopShellKind
  readonly patchable: boolean
  readonly reason: string
  readonly recommendedCarrier: RecommendedCarrier
  readonly root?: string
  readonly version?: string
}

interface CarrierHints {
  /** The stored `browser.channel`; a system browser the user already chose is the one to recommend. */
  readonly preferredBrowser?: string
  readonly platform?: NodeJS.Platform
}

/**
 * The system browser to recommend when the sidebar cannot carry the browser.
 * @param hints - the user's current channel and platform.
 * @returns `chrome` or `edge`.
 */
export function systemCarrier(hints: CarrierHints = {}): 'chrome' | 'edge' {
  if (hints.preferredBrowser === 'chrome' || hints.preferredBrowser === 'edge') return hints.preferredBrowser
  return (hints.platform ?? process.platform) === 'win32' ? 'edge' : 'chrome'
}

/**
 * Classify one candidate install from its identity reading.
 * @param root - the install directory.
 * @param identity - `readDesktopIdentity(root)`.
 * @param hints - used for the recommended carrier of an unpatchable shell.
 * @returns the report; `none` when the directory is not a DSH-named shell at all.
 */
export function classifyDesktopShell(root: string, identity: DesktopIdentity | IdentityRefusal, hints: CarrierHints = {}): DesktopShellReport {
  if (identity.ok) {
    return { kind: 'official-supported', patchable: true, reason: `DeepSeek Harness Desktop ${identity.version} at ${root}`, recommendedCarrier: 'sidebar', root, version: identity.version }
  }
  if (identity.shell === undefined) return { ...noDesktopShell(hints), reason: identity.reason }
  return {
    kind: identity.shell,
    patchable: false,
    reason: identity.reason,
    recommendedCarrier: systemCarrier(hints),
    root,
    ...identity.version === undefined ? {} : { version: identity.version },
  }
}

/**
 * The report when no DSH desktop shell was found.
 * @param hints - used for the recommended carrier.
 * @returns a `none` report.
 */
export function noDesktopShell(hints: CarrierHints = {}): DesktopShellReport {
  return {
    kind: 'none',
    patchable: false,
    reason: 'no DSH Desktop install found in the usual roots, at DSH_DESKTOP_PATH or DSH_DESKTOP_APP, in the uninstall registry, or at this platform\'s conventional locations',
    recommendedCarrier: systemCarrier(hints),
  }
}
