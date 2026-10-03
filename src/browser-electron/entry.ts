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

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from '../browser/runtime.js'
import { ElectronBrowserProvider } from './provider.js'
import type { ElectronBrowserViewHost } from './provider.js'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultHostMainPath, RemoteElectronViewHost } from './remote-host.js'
import { DesktopBridgeViewHost } from './desktop-bridge-host.js'
import { detectBrowser, searchSummary, SystemBrowserViewHost } from './system-browser.js'
import { claimEphemeralProfile, ephemeralProfileName, sweepAbandonedEphemeralProfiles } from './ephemeral-profile.js'
import { MissingSystemBrowserHost } from './missing-system-browser.js'
import { SettingsStore } from './settings-store.js'

export {
  ELECTRON_BROWSER_PROVIDER_ID,
  ElectronBrowserProvider,
} from './provider.js'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/** Plugin config: an optional externally-supplied view host. */
export interface Config {
  /** View host supplied by a desktop shell; absent -> self-host. */
  readonly viewHost?: ElectronBrowserViewHost
  /** Allow navigation only to HTTP(S) URLs. Default true. */
  readonly httpOnly?: boolean
  /**
   * Directory `browser_download` save paths must resolve inside (prevents a
   * prompt-injected agent from writing arbitrary machine paths). Default:
   * the user's Downloads folder; override to confine downloads elsewhere.
   */
  readonly downloadDir?: string
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /** Maximum content characters before truncation when no maxChars is given. No longer read: the cap is per format (html and json 50 000, otherwise 20 000). */
  readonly contentMaxChars?: number
}

export const Config: z<Config> = z.object({
  // Absent on surfaces without a desktop shell; the plugin self-hosts then.
  viewHost: z.any(),
  httpOnly: z.boolean().default(true),
  downloadDir: z.string(),
  snapshotMaxElements: z.number(),
  contentMaxChars: z.number(),
})

/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx: Context & { browser: BrowserRuntime }, config: Config): void {
  // One settings document per plugin instance: the settings panel writes it, the
  // provider reads it live, and both ends agree on the same file.
  const settings = new SettingsStore()
  installSettingsRoute(ctx, settings)

  const providerConfig = {
    httpOnly: config.httpOnly,
    downloadDir: config.downloadDir,
    snapshotMaxElements: config.snapshotMaxElements,
    contentMaxChars: config.contentMaxChars,
    settings: () => settings.get(),
  }

  // A host supplied by the composition (the desktop shell's own seam) wins and is
  // synchronous, so registration stays synchronous on that path.
  if (config.viewHost !== undefined) {
    const external = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(config.viewHost as ElectronBrowserViewHost, providerConfig))
    ctx.effect(() => () => { external() })
    return
  }

  // Otherwise start self-hosted — a working browser from the first call, on every
  // surface — and upgrade to the desktop sidebar if this machine has one. The
  // upgrade is deliberately a swap of the whole provider: the two carriers own
  // different lifetimes (a spawned child vs. the shell's view), and pretending
  // otherwise would leave a stray window behind.
  const selfHosted = new RemoteElectronViewHost(defaultHostMainPath())
  let unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(selfHosted, providerConfig))
  let upgraded = false

  ctx.effect(() => () => {
    unregister()
    selfHosted.dispose()
  })

  /**
   * Swap the provider to another carrier, releasing the previous one.
   * @param host - the carrier to adopt.
   * @param note - a one-line description for the log.
   */
  const adopt = (host: ElectronBrowserViewHost, note: string): void => {
    if (upgraded) { host.dispose?.(); return }
    upgraded = true
    try {
      unregister()
      unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(host, providerConfig))
      selfHosted.dispose()
      ctx.logger?.info?.(`dsh-builtin-browser: ${note}`)
    } catch (error) {
      // Never leave the surface without a provider.
      unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(
        new RemoteElectronViewHost(defaultHostMainPath()), providerConfig))
      ctx.logger?.warn?.(`dsh-builtin-browser: could not adopt ${note} (${String(error)})`)
    }
  }

  // A browser the user explicitly asked for outranks every automatic choice: the
  // whole point of the setting is that they know which browser they want. It is
  // launched with a plugin-owned profile, so their own windows are untouched.
  //
  // Registration is INERT: constructing the host starts nothing. The browser only
  // launches when a command actually needs a page, so merely running DSH never
  // spawns a browser window. (An earlier version launched it here, which meant a
  // browser appeared the moment the plugin loaded — reported and fixed.)
  const channel = settings.get().browser.channel
  // Naming a browser is a decision about which one to use, so it also decides whether the
  // desktop sidebar may take over. Skipping discovery for an explicit choice is what makes
  // that choice real — otherwise a user who picked Chrome would silently get the sidebar,
  // and a user who picked a browser that is not installed would never see the explanation
  // written for exactly that case, because the sidebar would quietly replace it.
  const explicitChoice = channel !== 'bundled' && channel !== 'auto'
  if (channel !== 'bundled') {
    const detected = detectBrowser(channel)
    if (detected === undefined) {
      // `auto` promises to take whatever is available, so falling back is what it
      // asked for. Naming a browser is a specific request, and quietly satisfying it
      // with a different one turns the real problem ("no Chrome here") into a
      // confusing error about Electron later on. Report it instead.
      if (channel === 'auto') {
        ctx.logger?.warn?.('dsh-builtin-browser: no installed browser was found; using the bundled browser')
      } else {
        adopt(new MissingSystemBrowserHost(channel, searchSummary(channel)),
          `the selected ${channel} is not installed — commands will explain how to fix it`)
      }
    } else {
      // Same profile root as settings-store, history-store and desktop-bridge-host: the
      // `?.dsh` component used to be missing HERE only, so a desktop launched from a
      // shortcut (no DSH_HOME in the environment) put its browser profile in
      // `C:\Users\<user>\dsh-builtin-browser-host\` while its settings and history lived in
      // `~/.dsh/dsh-builtin-browser-host/` — two half-profiles that never met, and a
      // settings panel whose switches appeared not to apply.
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      // Login state lives in the browser profile, so the cookies setting decides where
      // that profile goes: a stable directory keeps the user signed in across restarts
      // (the point of using their own browser), while turning persistence off gets a
      // throwaway directory that is removed when the browser is released.
      const persist = settings.get().cookies.persist
      const profileRoot = join(home, BROWSER_PROFILE_DIR)
      const profileDir = persist
        ? join(profileRoot, `${detected.kind}-profile`)
        : join(profileRoot, ephemeralProfileName(detected.kind, randomUUID()))
      if (!persist) {
        // A process killed outright never runs its own cleanup (see ephemeral-profile.ts),
        // so the sweep happens HERE — at the only moment that can still act on a profile
        // whose owner is gone — and before this run claims a directory of its own.
        sweepAbandonedEphemeralProfiles(profileRoot, detected.kind)
        claimEphemeralProfile(profileDir)
      }
      adopt(new SystemBrowserViewHost(detected, profileDir, [], persist ? undefined : profileDir),
        `will drive the installed ${detected.kind} (${detected.path}${persist ? '' : ', ephemeral profile'})`)
    }
  }

  // An explicit choice was already adopted above; discovering the sidebar here would
  // replace it, which is exactly what this guard prevents.
  if (explicitChoice) return

  void DesktopBridgeViewHost.discover().then(sidebar => {
    // No bridge (plain `dsh web`, an older desktop build, or a shell that already
    // exited): keep self-hosting, which is what every surface has always done.
    if (sidebar === undefined) return
    adopt(sidebar, 'driving the desktop sidebar browser')
  }).catch(() => { /* discovery never throws; keep self-hosting */ })
}

/** Route the settings panel reads and writes. */
const SETTINGS_ROUTE = '/dsh-builtin-browser/settings'

/**
 * The directory under the DSH home that holds this plugin's browser profile.
 *
 * Named once, because every consumer of it must agree: `settingsPath()` and the history
 * store resolve their own copy from `$DSH_HOME`, and a profile written under a different
 * root than the settings document is a pair that silently never meets.
 */
const BROWSER_PROFILE_DIR = 'dsh-builtin-browser-host'

/** The host web-server surface this plugin uses, described structurally. */
interface WebServerHost {
  readonly webServer: {
    register(
      spec: {
        readonly kind: 'exact'
        readonly path: string
        readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
      },
      label?: string,
    ): () => void
  }
  effect(callback: () => (() => void) | void): void
}

/**
 * Expose the settings document over the host's web server, which is how the
 * settings panel reads and writes it. A host without that service (headless /
 * CLI surfaces) simply skips this: the panel is then unreachable and the file
 * stays hand-editable — never a plugin-startup failure.
 * @param ctx - the plugin context.
 * @param settings - the settings document to expose.
 */
function installSettingsRoute(ctx: Context, settings: SettingsStore): void {
  const inject = (ctx as unknown as {
    inject?: (deps: readonly string[], callback: (host: WebServerHost) => void) => void
  }).inject
  if (typeof inject !== 'function') return
  try {
    inject(['webServer'], (host) => {
      host.effect(() => host.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (request, response) => handleSettingsRequest(request, response, settings),
      }, 'dsh-builtin-browser: settings'))
    })
  } catch {
    // No web server on this surface: the settings file remains the interface.
  }
}

/**
 * Same-origin guard. Settings are machine-local configuration, so a page loaded
 * elsewhere must not be able to read or rewrite them.
 * @param request - the incoming request.
 * @returns whether the request may touch the settings document.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = String(request.headers.origin ?? '').trim()
  if (origin === 'null') return false
  if (origin === '') return true
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

/**
 * One settings round-trip: `GET` reads the document, `PUT`/`POST` merges a
 * partial patch into it.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param settings - the settings document.
 */
async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settings: SettingsStore,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }
  if (!sameOrigin(request)) {
    json(403, { ok: false, error: 'cross-origin request refused' })
    return
  }
  const method = request.method ?? 'GET'
  if (method === 'GET') {
    json(200, { ok: true, settings: settings.get(), path: settings.path() })
    return
  }
  if (method !== 'PUT' && method !== 'POST') {
    response.writeHead(405, { allow: 'GET, PUT' })
    response.end()
    return
  }
  try {
    const body = await readBody(request)
    const patch: unknown = body.trim() === '' ? {} : JSON.parse(body)
    json(200, { ok: true, settings: settings.update(patch) })
  } catch (error) {
    json(400, { ok: false, error: `invalid settings patch: ${String(error)}` })
  }
}

/**
 * Read a request body with a hard cap (the settings patch is tiny, and an
 * unbounded read would let any same-origin caller exhaust memory).
 * @param request - the incoming request.
 * @param limit - maximum accepted characters.
 * @returns the body text.
 */
function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      text += String(chunk)
      if (text.length > limit) {
        request.destroy()
        reject(new Error('settings patch too large'))
      }
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}
