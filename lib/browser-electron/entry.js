/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects) that only a desktop shell can supply,
 * so the view host arrives through plugin config (the bundle patch reads it
 * from `ctx.get('electronViewHost')`).
 * @module dsh-browser/browser-electron
 */
import z from '@deepseek-ai/schemastery';
import { ElectronBrowserProvider } from "./provider.js";
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from "./provider.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron';
/** The browser seam this provider registers into. */
export const inject = ['browser'];
export const Config = z.object({
    viewHost: z.any(),
    httpOnly: z.boolean().default(true),
});
/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx, config) {
    ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(config.viewHost, { httpOnly: config.httpOnly }));
}
