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
import z from '@deepseek-ai/schemastery';
import { ElectronBrowserProvider } from './provider.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultHostMainPath, RemoteElectronViewHost } from './remote-host.js';
import { DesktopBridgeViewHost } from './desktop-bridge-host.js';
import { detectBrowser, searchSummary, SystemBrowserViewHost } from './system-browser.js';
import { claimEphemeralProfile, ephemeralProfileName, sweepAbandonedEphemeralProfiles } from './ephemeral-profile.js';
import { MissingSystemBrowserHost } from './missing-system-browser.js';
import { SettingsStore } from './settings-store.js';
import { sameOrigin } from './settings-route.js';
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from './provider.js';
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron';
/** The browser seam this provider registers into. */
export const inject = ['browser'];
export const Config = z.object({
    // Absent on surfaces without a desktop shell; the plugin self-hosts then.
    viewHost: z.any(),
    httpOnly: z.boolean().default(true),
    downloadDir: z.string(),
    snapshotMaxElements: z.number(),
    contentMaxChars: z.number(),
});
/**
 * This process's session id, read the way DSH's own desktop host reads it.
 *
 * `dsh-desktop-host/lib/index.js` does `ctx.get('agents')` then `agents.list()`, and uses
 * `agent.id` directly as a sessionId. One conversation per process, so the list holds this one.
 *
 * Returns undefined rather than throwing when the service is absent — an older host, or a
 * non-desktop composition. The caller falls back to a random id, which is what the bridge used
 * before and is safe: it only means "this process", not "this conversation".
 *
 * @param ctx - the plugin context.
 * @returns the session id, or undefined when it cannot be read.
 */
function readSessionId(ctx) {
    try {
        const surface = ctx;
        if (typeof surface.get !== 'function')
            return undefined;
        const agents = surface.get('agents');
        const list = typeof agents?.list === 'function' ? agents.list() : undefined;
        if (!Array.isArray(list) || list.length === 0)
            return undefined;
        const first = list[0];
        return typeof first?.id === 'string' && first.id !== '' ? first.id : undefined;
    }
    catch {
        return undefined;
    }
}
/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx, config) {
    // Which session is this process serving?
    //
    // The desktop shell keeps ONE sidebar per conversation — measured: two `[class*=_tabStrip]`
    // containers sat in the DOM at once, each carrying its own session id on the React fiber, and
    // the invisible one's webview was unloaded. So the bridge CAN tell which sidebar belongs to
    // whom; what it lacked was the other half, this process's own identity. Without it, the bridge
    // drove "whatever sidebar is on screen" and — measured on the running shell — typed into another
    // conversation's address bar and navigated that page.
    //
    // The identity is available here, and DSH's own desktop host shows how
    // (`dsh-desktop-host/lib/index.js`: `ctx.get('agents').list()`, with `agent.id` used directly as
    // a sessionId). One conversation per process, so the list holds this one.
    const sessionId = readSessionId(ctx);
    // One settings document per plugin instance: the settings panel writes it, the
    // provider reads it live, and both ends agree on the same file.
    const settings = new SettingsStore();
    installSettingsRoute(ctx, settings);
    const providerConfig = {
        httpOnly: config.httpOnly,
        downloadDir: config.downloadDir,
        snapshotMaxElements: config.snapshotMaxElements,
        contentMaxChars: config.contentMaxChars,
        settings: () => settings.get(),
    };
    // A host supplied by the composition (the desktop shell's own seam) wins and is
    // synchronous, so registration stays synchronous on that path.
    if (config.viewHost !== undefined) {
        const external = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(config.viewHost, providerConfig));
        ctx.effect(() => () => { external(); });
        return;
    }
    // Otherwise start self-hosted — a working browser from the first call, on every
    // surface — and upgrade to the desktop sidebar if this machine has one. The
    // upgrade is deliberately a swap of the whole provider: the two carriers own
    // different lifetimes (a spawned child vs. the shell's view), and pretending
    // otherwise would leave a stray window behind.
    const selfHosted = new RemoteElectronViewHost(defaultHostMainPath());
    let unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(selfHosted, providerConfig));
    let upgraded = false;
    ctx.effect(() => () => {
        unregister();
        selfHosted.dispose();
    });
    /**
     * Swap the provider to another carrier, releasing the previous one.
     * @param host - the carrier to adopt.
     * @param note - a one-line description for the log.
     */
    const adopt = (host, note) => {
        if (upgraded) {
            host.dispose?.();
            return;
        }
        upgraded = true;
        try {
            unregister();
            unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(host, providerConfig));
            selfHosted.dispose();
            ctx.logger?.info?.(`dsh-builtin-browser: ${note}`);
        }
        catch (error) {
            // Never leave the surface without a provider. The half-built host is disposed FIRST: an
            // adopt that got as far as constructing it may already hold a socket, a listener or a child
            // process, and dropping it on the floor is how a failed upgrade becomes a leak that only
            // shows up as a stray Electron in the task manager.
            try {
                host.dispose?.();
            }
            catch { /* the fallback below matters more than this */ }
            // The fallback registration gets its own guard, because THIS is the path taken when the
            // context is already gone — and then `ctx.browser` throws `cannot get required service
            // "browser" in inactive context`. Unguarded, that second throw escaped the async retry
            // that calls `adopt`, became an unhandled rejection, and killed the host process with
            // exit code 1: a failed upgrade, which should only ever cost a warning, took the whole
            // session down instead. Observed 2026-10-05 (crash-…-host.log, phase: running).
            try {
                unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(new RemoteElectronViewHost(defaultHostMainPath()), providerConfig));
                ctx.logger?.warn?.(`dsh-builtin-browser: could not adopt ${note} (${String(error)})`);
            }
            catch (fallbackError) {
                ctx.logger?.warn?.(`dsh-builtin-browser: could not adopt ${note} (${String(error)}), and the fallback `
                    + `registration also failed (${String(fallbackError)}) — no browser provider is `
                    + 'registered for this context');
            }
        }
    };
    // A browser the user explicitly asked for outranks every automatic choice: the
    // whole point of the setting is that they know which browser they want. It is
    // launched with a plugin-owned profile, so their own windows are untouched.
    //
    // Registration is INERT: constructing the host starts nothing. The browser only
    // launches when a command actually needs a page, so merely running DSH never
    // spawns a browser window. (An earlier version launched it here, which meant a
    // browser appeared the moment the plugin loaded — reported and fixed.)
    const channel = settings.get().browser.channel;
    // Naming a browser is a decision about which one to use, so it also decides whether the
    // desktop sidebar may take over. Skipping discovery for an explicit choice is what makes
    // that choice real — otherwise a user who picked Chrome would silently get the sidebar,
    // and a user who picked a browser that is not installed would never see the explanation
    // written for exactly that case, because the sidebar would quietly replace it.
    const explicitChoice = channel !== 'bundled' && channel !== 'auto' && channel !== 'sidebar';
    if (channel !== 'bundled' && channel !== 'sidebar') {
        const detected = detectBrowser(channel);
        if (detected === undefined) {
            // `auto` promises to take whatever is available, so falling back is what it
            // asked for. Naming a browser is a specific request, and quietly satisfying it
            // with a different one turns the real problem ("no Chrome here") into a
            // confusing error about Electron later on. Report it instead.
            if (channel === 'auto') {
                ctx.logger?.warn?.('dsh-builtin-browser: no installed browser was found; using the bundled browser');
            }
            else {
                adopt(new MissingSystemBrowserHost(channel, searchSummary(channel)), `the selected ${channel} is not installed — commands will explain how to fix it`);
            }
        }
        else {
            // Same profile root as settings-store, history-store and desktop-bridge-host: the
            // `?.dsh` component used to be missing HERE only, so a desktop launched from a
            // shortcut (no DSH_HOME in the environment) put its browser profile in
            // `C:\Users\<user>\dsh-builtin-browser-host\` while its settings and history lived in
            // `~/.dsh/dsh-builtin-browser-host/` — two half-profiles that never met, and a
            // settings panel whose switches appeared not to apply.
            const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
            // Login state lives in the browser profile, so the cookies setting decides where
            // that profile goes: a stable directory keeps the user signed in across restarts
            // (the point of using their own browser), while turning persistence off gets a
            // throwaway directory that is removed when the browser is released.
            const persist = settings.get().cookies.persist;
            const profileRoot = join(home, BROWSER_PROFILE_DIR);
            const profileDir = persist
                ? join(profileRoot, `${detected.kind}-profile`)
                : join(profileRoot, ephemeralProfileName(detected.kind, randomUUID()));
            if (!persist) {
                // A process killed outright never runs its own cleanup (see ephemeral-profile.ts),
                // so the sweep happens HERE — at the only moment that can still act on a profile
                // whose owner is gone — and before this run claims a directory of its own.
                sweepAbandonedEphemeralProfiles(profileRoot, detected.kind);
                claimEphemeralProfile(profileDir);
            }
            adopt(new SystemBrowserViewHost(detected, profileDir, [], persist ? undefined : profileDir), `will drive the installed ${detected.kind} (${detected.path}${persist ? '' : ', ephemeral profile'})`);
        }
    }
    // An explicit choice was already adopted above; discovering the sidebar here would
    // replace it, which is exactly what this guard prevents.
    //
    // `sidebar` is explicit too, but it names the sidebar, so it is the one explicit choice that
    // must FALL THROUGH to the discovery below instead of returning here.
    if (explicitChoice && channel !== 'sidebar')
        return;
    // The shell may not be up yet. `dsh web` starts before — or entirely without — the desktop app
    // that hosts the bridge, and a one-shot discovery meant a bridge that appeared a second later
    // was never adopted for the rest of the process's life. Retry a handful of times over roughly
    // half a minute, then stop: this is a convenience, not a promise, and the session the user is
    // already driving in the self-hosted window is not worth replacing minutes into their work.
    // `adopt` is itself one-shot (its `upgraded` guard), so the only possible effect of a retry
    // that lands late is adopting a bridge that showed up just after startup.
    void (async () => {
        for (const delay of [0, 2_000, 5_000, 15_000]) {
            if (delay > 0)
                await new Promise(resolve => setTimeout(resolve, delay));
            let sidebar;
            try {
                sidebar = await DesktopBridgeViewHost.discover(sessionId);
            }
            catch {
                sidebar = undefined; // discovery is documented not to throw; never let it stop the retries
            }
            if (sidebar === undefined)
                continue;
            adopt(sidebar, 'driving the desktop sidebar browser');
            return;
        }
        // The user explicitly asked for the sidebar, so silence would leave them with a setting
        // that did nothing and no way to tell why. This is reachable on `dsh web`, and on a desktop
        // whose shell never published a bridge endpoint. An automatic attempt stays quiet (the
        // self-hosted window is a fine outcome); an explicit request does not.
        if (channel === 'sidebar') {
            ctx.logger?.warn?.('dsh-builtin-browser: the sidebar browser was requested but no desktop bridge was found — '
                + 'this DSH has no desktop shell, or its bridge never started. Falling back to the bundled '
                + 'browser; set browser.channel to another value to silence this.');
        }
    })();
}
/** Route the settings panel reads and writes. */
const SETTINGS_ROUTE = '/dsh-builtin-browser/settings';
/**
 * The directory under the DSH home that holds this plugin's browser profile.
 *
 * Named once, because every consumer of it must agree: `settingsPath()` and the history
 * store resolve their own copy from `$DSH_HOME`, and a profile written under a different
 * root than the settings document is a pair that silently never meets.
 */
const BROWSER_PROFILE_DIR = 'dsh-builtin-browser-host';
/**
 * Expose the settings document over the host's web server, which is how the
 * settings panel reads and writes it. A host without that service (headless /
 * CLI surfaces) simply skips this: the panel is then unreachable and the file
 * stays hand-editable — never a plugin-startup failure.
 * @param ctx - the plugin context.
 * @param settings - the settings document to expose.
 */
function installSettingsRoute(ctx, settings) {
    const inject = ctx.inject;
    if (typeof inject !== 'function')
        return;
    try {
        inject(['webServer'], (host) => {
            host.effect(() => host.webServer.register({
                kind: 'exact',
                path: SETTINGS_ROUTE,
                handler: (request, response) => handleSettingsRequest(request, response, settings),
            }, 'dsh-builtin-browser: settings'));
        });
    }
    catch {
        // No web server on this surface: the settings file remains the interface.
    }
}
/**
 * One settings round-trip: `GET` reads the document, `PUT`/`POST` merges a
 * partial patch into it. Admission lives in `settings-route.ts` so it can be tested.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param settings - the settings document.
 */
async function handleSettingsRequest(request, response, settings) {
    const json = (status, body) => {
        response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
    };
    const method = request.method ?? 'GET';
    if (!sameOrigin(request, method !== 'GET')) {
        json(403, { ok: false, error: 'cross-origin request refused' });
        return;
    }
    if (method === 'GET') {
        json(200, { ok: true, settings: settings.get(), path: settings.path() });
        return;
    }
    if (method !== 'PUT' && method !== 'POST') {
        response.writeHead(405, { allow: 'GET, PUT' });
        response.end();
        return;
    }
    try {
        const body = await readBody(request);
        const patch = body.trim() === '' ? {} : JSON.parse(body);
        json(200, { ok: true, settings: settings.update(patch) });
    }
    catch (error) {
        json(400, { ok: false, error: `invalid settings patch: ${String(error)}` });
    }
}
/**
 * Read a request body with a hard cap (the settings patch is tiny, and an
 * unbounded read would let any same-origin caller exhaust memory).
 * @param request - the incoming request.
 * @param limit - maximum accepted characters.
 * @returns the body text.
 */
function readBody(request, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let text = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            text += String(chunk);
            if (text.length > limit) {
                request.destroy();
                reject(new Error('settings patch too large'));
            }
        });
        request.on('end', () => resolve(text));
        request.on('error', reject);
    });
}
