/**
 * dsh-builtin-browser plugin entry: aggregates the shared-browser capability
 * pieces. The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-builtin-browser/browser`          -> the ctx.browser seam (Service)
 *   - `dsh-builtin-browser/browser-electron` -> the Electron CDP provider
 *   - `dsh-builtin-browser/tool-browser`     -> the model-facing browser_* tools
 * This root entry only re-exports for programmatic use; the loader rows are
 * the composition surface.
 * @module dsh-builtin-browser
 */
export { BrowserError } from "./browser/types.js";
export { BrowserRuntime } from "./browser/runtime.js";
export { ElectronBrowserProvider } from "./browser-electron/provider.js";
export { RemoteElectronViewHost, defaultHostMainPath } from "./browser-electron/remote-host.js";
