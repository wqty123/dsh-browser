/**
 * dsh-browser plugin entry: aggregates the shared-browser capability pieces.
 * The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-browser/browser`            -> the ctx.browser seam (Service Definition)
 *   - `dsh-browser/browser-electron`   -> the Electron CDP provider
 *   - `dsh-browser/tool-browser`       -> the model-facing browser_* tools
 * This root entry only re-exports for programmatic use; the loader rows are
 * the composition surface.
 * @module dsh-browser
 */
export { BrowserError } from './browser/types.ts';
export type { BrowserClickRequest, BrowserContentFormat, BrowserContentRequest, BrowserContentResult, BrowserExecuteRequest, BrowserExecuteResult, BrowserNavigateRequest, BrowserOpenRequest, BrowserProvider, BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotElement, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, } from './browser/types.ts';
export { BrowserRuntime } from './browser/runtime.ts';
export { ElectronBrowserProvider } from './browser-electron/provider.ts';
export type { ElectronBrowserViewHost, ElectronViewHandle } from './browser-electron/provider.ts';
