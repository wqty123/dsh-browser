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
import type { BrowserRuntime } from '../browser/runtime.js';
import type { ElectronBrowserViewHost } from './provider.js';
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from './provider.js';
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.js';
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
    /**
     * Directory `browser_download` save paths must resolve inside (prevents a
     * prompt-injected agent from writing arbitrary machine paths). Default:
     * the user's Downloads folder; override to confine downloads elsewhere.
     */
    readonly downloadDir?: string;
    /** Maximum snapshot elements before truncation. Default 60. */
    readonly snapshotMaxElements?: number;
    /** Maximum content characters before truncation when no maxChars is given. No longer read: the cap is per format (html and json 50 000, otherwise 20 000). */
    readonly contentMaxChars?: number;
}
export declare const Config: z<Config>;
/** Register the Electron browser provider with `ctx.browser`. */
export declare function apply(ctx: Context & {
    browser: BrowserRuntime;
}, config: Config): void;
/**
 * Move a browser profile left behind by the old layout into the directory the plugin uses now.
 *
 * Before the `?.dsh` component was added here, a desktop launched from a shortcut (no `DSH_HOME`
 * in the environment) put its browser profile in `<homedir>/dsh-builtin-browser-host/` while its
 * settings and history lived in `<homedir>/.dsh/dsh-builtin-browser-host/`. Login state lives
 * INSIDE the browser profile, so leaving the old directory behind silently signs the user out of
 * everything they had signed into — reported after the fix shipped, as a one-time cost of it.
 *
 * That cost does not have to be paid. The move happens only when the new location is absent, so a
 * profile in use is never overwritten, and every failure — a cross-device rename, a permission
 * problem, a profile another process holds — falls through to an empty profile, which is exactly
 * what would have happened without this function. The old directory is then left untouched rather
 * than deleted, because a half-moved profile is worse than a stale one.
 *
 * @param profileRoot - the root the plugin resolves today (`<DSH_HOME>/dsh-builtin-browser-host`).
 * @param legacyRoot - the pre-`DSH_HOME` layout's root. Injected so the move can be exercised
 *   without touching the real home directory.
 */
export declare function adoptLegacyProfileRoot(profileRoot: string, legacyRoot?: string): void;
