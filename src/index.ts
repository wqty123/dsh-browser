/**
 * dsh-builtin-browser plugin entry: aggregates the shared-browser capability
 * pieces. The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-builtin-browser/browser`          -> the ctx.browser seam (Service)
 *   - `dsh-builtin-browser/browser-electron` -> the Electron CDP provider
 *   - `dsh-builtin-browser/tool-browser`     -> the model-facing dsh_browser_* tools
 * The capability itself is composed by those rows; this root entry exists for
 * programmatic imports AND because the host's client-module scan identifies a
 * package's browser half through a loader row whose specifier resolves to the
 * PACKAGE ROOT. A row named after a subpath (`dsh-builtin-browser/browser`) is
 * not a package specifier and is skipped by design, which is why the patch also
 * registers a row under the bare package name — see cordis.patch.yml.
 * @module dsh-builtin-browser
 */

/** Plugin identity for the root row (the composition surface is the subpath rows). */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-builtin-browser'

/**
 * Inert application for the root row: the browser seam, the Electron provider and
 * the tools are mounted by the subpath rows, so this one only exists to give the
 * package a loader row named after the package itself. Without it the host's
 * client scan finds no row to resolve `dsh.client` from, and the settings panel
 * never reaches the browser (the plugin works, its client half is invisible).
 */
import { registerWebGuest } from './web-guest.ts'

/**
 * 根行只做与载体无关的装配：侧栏 guest 代理必须始终存在，不能依赖 Electron 行。
 * @param ctx - 插件容器。
 */
export function apply(ctx: Context): void {
  registerWebGuest(ctx)
}


export { BrowserError } from './browser/types.ts'
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
} from './browser/types.ts'
export { BrowserRuntime } from './browser/runtime.ts'
export { BrowserReferenceService, createReferenceService, summarizeReference } from './browser-reference/service.ts'
export type {
  BrowserReferenceDraftAdapter,
  CaptureFailure,
  CaptureOutcome,
  CaptureRequest,
  ReferenceHost,
  ReferenceSummary,
  RevealOutcome,
  RevealPartResult,
} from './browser-reference/service.ts'
export type {
  BrowserReference,
  BrowserReferenceCarrier,
  BrowserReferenceEntry,
  BrowserReferenceOrigin,
  BrowserReferencePart,
  ImageAnchor,
  ImageReferencePart,
  TableAnchor,
  TableCellRun,
  TableCellSnapshot,
  TableReferencePart,
  TableSnapshot,
  TextQuoteAnchor,
  TextReferencePart,
} from './browser-reference/types.ts'
export { manifestHashOf, ReferenceStore, referenceStorePath } from './browser-reference/store.ts'
export { buildTextAnchor, findTextQuote } from './browser-reference/text-quote.ts'
export { ElectronBrowserProvider } from './browser-electron/provider.ts'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './browser-electron/provider.ts'
export { RemoteElectronViewHost, defaultHostMainPath } from './browser-electron/remote-host.ts'
