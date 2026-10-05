/**
 * dsh-builtin-browser plugin entry: aggregates the shared-browser capability
 * pieces. The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-builtin-browser/browser`          -> the ctx.browser seam (Service)
 *   - `dsh-builtin-browser/browser-electron` -> the Electron CDP provider
 *   - `dsh-builtin-browser/tool-browser`     -> the model-facing browser_* tools
 * The capability itself is composed by those rows; this root entry exists for
 * programmatic imports AND because the host's client-module scan identifies a
 * package's browser half through a loader row whose specifier resolves to the
 * PACKAGE ROOT. A row named after a subpath (`dsh-builtin-browser/browser`) is
 * not a package specifier and is skipped by design, which is why the patch also
 * registers a row under the bare package name — see cordis.patch.yml.
 * @module dsh-builtin-browser
 */

/** Plugin identity for the root row (the composition surface is the subpath rows). */
import { probeLoad } from './load-probe.js'

export const name = 'dsh-builtin-browser'

/**
 * Inert application for the root row: the browser seam, the Electron provider and
 * the tools are mounted by the subpath rows, so this one only exists to give the
 * package a loader row named after the package itself. Without it the host's
 * client scan finds no row to resolve `dsh.client` from, and the settings panel
 * never reaches the browser (the plugin works, its client half is invisible).
 */
export function apply(): void {
  probeLoad('dsh-builtin-browser')
}


export { BrowserError } from './browser/types.js'
export type {
  BrowserA11yNode,
  BrowserA11yRequest,
  BrowserA11yResult,
  BrowserChallenge,
  BrowserCheckRequest,
  BrowserClearRequest,
  BrowserClickRequest,
  BrowserContentFormat,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserElementTarget,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserFillField,
  BrowserFillRequest,
  BrowserFillResult,
  BrowserGetValueRequest,
  BrowserGetValueResult,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserScrapeField,
  BrowserScrapeRequest,
  BrowserScrapeResult,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSelectRequest,
  BrowserSelectResult,
  BrowserSessionId,
  BrowserSetValueRequest,
  BrowserSetValueResult,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  BrowserTab,
  BrowserTypeRequest,
  ExportedCookie,
} from './browser/types.js'
export { BrowserRuntime } from './browser/runtime.js'
export { ElectronBrowserProvider } from './browser-electron/provider.js'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './browser-electron/provider.js'
export { RemoteElectronViewHost, defaultHostMainPath } from './browser-electron/remote-host.js'
