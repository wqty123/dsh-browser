/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects). When a desktop shell supplies
 * `ctx.electronViewHost`, that host is used (embedded, human-machine shared
 * view). Otherwise the plugin self-hosts: it spawns its own Electron child
 * (`host-main.js`) and drives it over a local TCP JSON-RPC socket, so
 * installing the plugin is enough for `browser_*` tools to work on any
 * surface.
 * @module dsh-browser/browser-electron
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserRuntime } from '../browser/runtime.ts';
import type { ElectronBrowserViewHost } from './provider.ts';
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from './provider.ts';
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-electron";
/** The browser seam this provider registers into. */
export declare const inject: string[];
/** Plugin config: an optional externally-supplied view host. */
export interface Config {
    /** View host supplied by a desktop shell; absent -> self-host. */
    readonly viewHost?: ElectronBrowserViewHost;
    /** Allow navigation only to HTTP(S) URLs. Default true. */
    readonly httpOnly?: boolean;
}
export declare const Config: z<Config>;
/** Register the Electron browser provider with `ctx.browser`. */
export declare function apply(ctx: Context & {
    browser: BrowserRuntime;
}, config: Config): void;
