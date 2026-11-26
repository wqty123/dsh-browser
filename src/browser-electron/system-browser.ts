import { PATH_NAMES, INSTALL_LOCATIONS } from '../../assets/browser-products.mjs'
import { cdpVersionUrl, CDP_DEFAULT_ATTACH_PORT, CDP_ATTACH_PROBE_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
/**
 * Drive the browser the user already has (Chrome / Edge / any Chromium) instead of
 * the Electron we ship — the same approach Codex Browser Use takes.
 *
 * WHY
 * The bundled Electron is a private copy with its own profile, so it can never see
 * the logins the user already has in Chrome, and on a managed machine the user may
 * simply prefer their own browser. Launching their browser with a *separate*
 * `--user-data-dir` gives us a real Chromium we can drive over CDP without touching
 * their everyday profile, bookmarks or windows: nothing of theirs is opened, locked
 * or modified, and closing us never closes them.
 *
 * HOW
 * Chromium exposes CDP on `--remote-debugging-port=0`, and writes the port it chose
 * into `<profile>/DevToolsActivePort`. That file is the discovery mechanism — no
 * port guessing, no collisions. From there everything is CDP over one WebSocket:
 * `Target.createTarget` makes a page, `Target.attachToTarget` (flattened) gives a
 * session for it, and the plugin's commands ride that session. Node 22 ships a global
 * `WebSocket`, so this needs no dependency at all.
 *
 * WHAT IT IMPLEMENTS
 * The same `ElectronBrowserViewHost` seam as the self-hosted and sidebar hosts, so
 * the provider, the tools, history, the cursor and teardown rules are unchanged —
 * only the carrier differs.
 * @module dsh-browser/browser-electron/system-browser
 */

import { readFileSync, rmSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { acquireProfileLease, type ProfileLease } from './profile-lease.ts'
import { watchForeground, type ForegroundEvent, type ForegroundWatch, type ForegroundWatcher } from './foreground-watch.ts'
import { BrowserProcessOwnership, type ProcessOwnershipOptions } from './process-ownership.ts'
// Type-only: settings-store imports BrowserChannel from here, so a value import would be a cycle.
// `hasDisplay` lives here instead of there for the same reason — it is a runtime function.
import type { HeadlessMode } from './settings-store.ts'

/**
 * How long a killed browser is given to actually exit before the launch proceeds.
 *
 * `kill()` only sends the signal — on Windows it is TerminateProcess, which is asynchronous —
 * and the browser may hold this profile's singleton lock for a while afterwards. Spawning
 * immediately meant the replacement saw a live instance, handed its command line over and
 * exited, and that exit was reported as a bad browser path.
 */
const EXIT_GRACE_MS = 3_000
/**
 * How long a browser is given to close itself after being asked, before it is killed.
 *
 * Long enough for Chrome to flush its profile, which is what keeps the next launch from reading
 * the profile as crashed and offering a session restore. Deliberately not the same knob as
 * {@link EXIT_GRACE_MS}: that one waits for a browser to die because a NEW one cannot start until
 * it does, this one merely prefers a graceful exit to a kill.
 */
const CLOSE_GRACE_MS = 6_000

/**
 * Ceiling on one attempt to ask a discovered CDP port who it is.
 *
 * The launch loop below polls: it reads `DevToolsActivePort`, tries `/json/version` on the port
 * inside it, and waits 250 ms between attempts under a 30 s deadline. An unbounded fetch can
 * park inside one iteration for the whole budget, so a bound is needed — but it has to be
 * small enough that the loop still behaves like a loop.
 *
 * The usual case is NOT a slow answer, it is NO answer: a browser that has written the file but
 * is not listening yet refuses the connection instantly, and that immediacy is what lets the
 * loop spin. Any timeout added here is paid on every iteration in which the port is not ready,
 * so an earlier attempt at this used 2000 ms — eight times the poll interval — and cut the
 * attempts available in the budget from roughly 120 to 15. This value is the same size as the
 * interval, so a worst-case iteration costs 500 ms and the budget still affords ~60 attempts.
 */
const PORT_PROBE_MS = 250

/**
 * Starts a browser process and returns a handle to it.
 *
 * Injectable so tests can supply something that speaks CDP — the seam a recovery test needs
 * and could not have while the launch was hardcoded to a stub that rejects Chromium's args.
 * @param path - the executable to run.
 * @param args - its arguments.
 * @returns the child process.
 */
export type BrowserLauncher = (path: string, args: readonly string[]) => ReturnType<typeof spawn>

export interface SystemBrowserLaunchDiagnostic {
  cleanup?: 'ownership-unverified'
  stderrTail: string
  exitCode: number | null
  signal: string | null
  devToolsActivePortPresent: boolean
}

function diagnosticTail(value: string): string {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, '[URL redacted]')
    .replace(/\b(authorization|cookie|password|token|secret)(\s*[:=]\s*)[^\r\n]+/giu, '$1$2[redacted]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .split('\n').slice(-12).join('\n').slice(-2048)
}

/** The real launcher: retain stderr for bounded launch diagnostics. */
const defaultLauncher: BrowserLauncher = (path, args) =>
  spawn(path, [...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false })
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { CommandOptions, ElectronBrowserViewHost, ElectronViewHandle, QuietRevealOptions } from './provider.ts'
import type { CarrierPage } from '../browser/types.ts'
import { readTabHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, tabWireId, type BrowserSessionWireId, type BrowserTabWireId } from '../browser/handles.ts'

/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'electron' | 'chrome' | 'edge' | 'auto' | 'sidebar'

/** A resolved browser installation. */
export interface DetectedBrowser {
  /** Which product this is. */
  readonly kind: 'chrome' | 'edge' | 'brave'
  /** Absolute path to the executable. */
  readonly path: string
}

/**
 * Whether a browser's self-reported product name is one this carrier could have launched.
 *
 * `edg`, not `edge`: Edge reports itself as `Edg/155.0.4283.45`, both over HTTP and over the
 * protocol. Testing for the full word rejected a live Edge that had just been started, so the
 * call failed with the hand-off error this check was added to prevent — while the browser was
 * running the whole time, answering on its own port.
 * @param product - the product string a browser reports about itself.
 */
function isBrowserProduct(product: unknown): boolean {
  return typeof product === 'string' && /chrome|chromium|edg/i.test(product)
}

/**
 * Whether this process has somewhere to draw a window.
 *
 * The same test Chromium makes: with neither `DISPLAY` nor `WAYLAND_DISPLAY` set it cannot open a
 * window and exits with "could not connect to display". Declared here rather than in
 * settings-store because that module imports from this one, and a value import back would be a
 * cycle; the equivalent export there delegates to this.
 * @param env - the environment to inspect; defaults to the current process.
 * @returns true when a display is advertised.
 */
function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  // Windows and macOS use neither variable, and always have a window server.
  if (process.platform === 'win32' || process.platform === 'darwin') return true
  return (env.DISPLAY ?? '') !== '' || (env.WAYLAND_DISPLAY ?? '') !== ''
}

/**
 * Resolve `auto` into a concrete decision, and say why.
 *
 * Chromium refuses to start without a display: with neither `DISPLAY` nor `WAYLAND_DISPLAY` set it
 * exits at once with "could not connect to display", and the caller sees only "exited immediately
 * after launch (exit code 1)". That is the ordinary state of a systemd service, a container, and an
 * SSH-only server — the deployment where a server-side browser is most useful, and the one reported
 * as issue #32: every `dsh_browser_*` call failed, with nothing in the message pointing at the
 * display.
 *
 * `auto` therefore launches headless exactly when there is no display, which leaves desktop and
 * sidebar users with the visible window they expect. An environment override wins over the setting
 * so an operator can fix a running deployment without editing settings: `DSH_BROWSER_HEADLESS=1`
 * forces headless, `=0` forces a window.
 * @param mode - the configured mode.
 * @param env - the environment to inspect; defaults to the current process.
 * @returns whether to launch headless, and a one-line reason for the log.
 */
function resolveLaunchMode(
  mode: HeadlessMode,
  env: NodeJS.ProcessEnv = process.env,
): { readonly headless: boolean; readonly why: string } {
  const override = env.DSH_BROWSER_HEADLESS
  if (override === '1' || override === 'true') return { headless: true, why: 'DSH_BROWSER_HEADLESS' }
  if (override === '0' || override === 'false') return { headless: false, why: 'DSH_BROWSER_HEADLESS' }
  if (mode === 'headless') return { headless: true, why: 'browser.headless = headless' }
  if (mode === 'windowed') return { headless: false, why: 'browser.headless = windowed' }
  const display = hasDisplay(env)
  return display
    ? { headless: false, why: 'a display is available' }
    : { headless: true, why: 'no DISPLAY or WAYLAND_DISPLAY' }
}

/**
 * Whether a target URL is one of the blanks a browser opens by itself.
 *
 * Deliberately narrow: `about:blank` and Chrome's own new-tab pages, and nothing else. A wider
 * test ("has no path", "starts with chrome://") would sooner or later match a page the user is
 * reading, and the caller closes what this returns.
 * @param url - the target's reported URL.
 */
function isBlankUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  return url === 'about:blank'
    || url.startsWith('chrome://newtab')
    || url.startsWith('chrome://new-tab-page')
}

function expandLocation(location: string, env: NodeJS.ProcessEnv): string {
  return location.replace(/%([^%]+)%/g, (whole, name: string) =>
    env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()] ?? whole)
}

/**
 * Find an executable by name on PATH.
 *
 * PATH is read from the supplied environment rather than the process's own, so the
 * detection stays testable. On Windows a bare name needs its extension; elsewhere
 * the launcher is the file itself.
 * @param names - candidate launcher names, in preference order.
 * @param env - the environment to read PATH from.
 * @param platform - the platform whose PATH and extension conventions apply.
 * @returns the first existing absolute path, or undefined.
 */
function findOnPath(names: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  // Windows spells it Path as often as PATH; the separator differs too.
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  const directories = raw.split(separator).map(entry => entry.trim()).filter(entry => entry !== '')
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const name of names) {
    for (const directory of directories) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * Find an installed Chromium browser.
 *
 * `auto` prefers Chrome, then Edge, then Brave — the order reflects how likely each
 * is to be the browser a user actually chose rather than one the system shipped.
 * Each candidate is looked up in three places, most specific first: an explicit
 * environment override, then PATH, then the platform's conventional install
 * locations. PATH comes before the fixed paths because it is what actually reflects
 * how the browser was installed.
 * @param channel - the configured choice; `bundled` / `electron` never resolve to a system browser.
 * @param env - environment lookup, injected so tests need no real machine.
 * @param platform - the platform to use conventions for; injected for the same reason.
 * @returns the detected browser, or undefined when the choice is unavailable.
 */
export function detectBrowser(
  channel: BrowserChannel,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DetectedBrowser | undefined {
  if (channel === 'bundled' || channel === 'electron' || channel === 'sidebar') return undefined
  const order: DetectedBrowser['kind'][] = channel === 'auto' ? ['chrome', 'edge', 'brave'] : [channel as DetectedBrowser['kind']]
  for (const kind of order) {
    const fromEnv = (kind === 'chrome' ? env.DSH_BROWSER_CHROME_PATH : kind === 'edge' ? env.DSH_BROWSER_EDGE_PATH : undefined)
    if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return { kind, path: fromEnv }
    const onPath = findOnPath(PATH_NAMES[kind]?.[platform] ?? [], env, platform)
    if (onPath !== undefined) return { kind, path: onPath }
    for (const raw of INSTALL_LOCATIONS[kind]?.[platform] ?? []) {
      const candidate = expandLocation(raw, env)
      if (existsSync(candidate)) return { kind, path: candidate }
    }
  }
  return undefined
}

/**
 * Everything that was checked for one product, for reporting a miss.
 *
 * Detection returns undefined with no explanation, which left the caller able to say
 * only "not found". This gives the user the actual list so they can see whether the
 * plugin looked somewhere their browser is not.
 * @param kind - the product to describe.
 * @param platform - the platform whose names and locations apply.
 * @returns the launcher names (as PATH lookups) and the fixed locations checked.
 */
export function searchSummary(
  kind: DetectedBrowser['kind'],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const onPath = (PATH_NAMES[kind]?.[platform] ?? []).map(name => `${name} (on PATH)`)
  // Expanded, so the report names the location that was actually tested rather than a template
  // the user cannot paste into a file manager.
  const located = (INSTALL_LOCATIONS[kind]?.[platform] ?? []).map(entry => expandLocation(entry, env))
  return [...onPath, ...located]
}

/**
 * Where quiet mode first parks its window: past ordinary displays while staying under Win32's
 * 16-bit signed coordinate ceiling (32767 physical pixels) even at 125%-300% DPI scaling. Any
 * ultra-wide multi-monitor overlap is pushed further out by {@link clearDisplays}.
 */
const QUIET_PARK = { left: 10000, top: 0, width: 1280, height: 800 } as const
const QUIET_PARK_GAP = 200
const QUIET_PARK_LEFT_TOLERANCE = 2000
const QUIET_PARK_TOP_TOLERANCE = 256
const QUIET_REVEAL_INSET = 40
const QUIET_FRONT_SLACK = 16

interface QuietFront { readonly client: CdpClient; readonly session: string; readonly targetId: string }

interface WindowGeometry { readonly sl: number; readonly st: number; readonly sw: number; readonly sh: number; readonly x: number; readonly y: number; readonly ow: number; readonly oh: number; readonly hidden: boolean }

/** The display the page's window is on (or nearest to), the window's outer rectangle, and whether the page is hidden. */
async function windowGeometry(client: CdpClient, sessionId: string): Promise<WindowGeometry | undefined> {
  const out = await client.send('Runtime.evaluate', {
    expression: '({ sl: screen.availLeft, st: screen.availTop, sw: screen.availWidth, sh: screen.availHeight, x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, hidden: document.visibilityState === "hidden" })',
    returnByValue: true,
  }, sessionId) as { result?: { value?: WindowGeometry } } | undefined
  const g = out?.result?.value
  return g !== undefined && [g.sl, g.st, g.sw, g.sh, g.x, g.y, g.ow, g.oh].every(n => typeof n === 'number') ? g : undefined
}

/** One CDP connection to a browser-level WebSocket, with flattened sessions. */
class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly ready: Promise<void>
  readonly destroyedTargets = new Set<string>()
  headless = false

  /**
   * @param url - the browser's `webSocketDebuggerUrl`.
   */
  constructor(url: string) {
    // Node 22 provides WebSocket globally; no dependency is added for this.
    const socket = new WebSocket(url)
    this.socket = socket
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('dsh-builtin-browser: could not reach the browser over CDP')))
    })
    socket.addEventListener('message', event => this.onMessage(String((event as MessageEvent).data)))
    socket.addEventListener('close', () => this.fail(new Error('dsh-builtin-browser: the browser closed the CDP connection')))
  }

  private readonly socket: WebSocket

  /**
   * Resolve once the socket is open.
   *
   * Bounded on purpose. `ready` settles on the socket's own `open` or `error` events, and
   * a connection that is dropped by something in between may deliver neither — in which
   * case an unbounded await here would hang the tool call forever, because the caller's
   * own deadline is only checked between polls and this await happens inside one of them.
   * @returns when the handshake completed.
   */
  /**
   * Whether the socket is still usable.
   *
   * A dropped connection is not reported to the caller of send(); the pending command
   * would simply never complete. Asking the socket directly is what lets a cached client
   * be discarded instead of reused, which is the difference between a restart and a 30s
   * hang on every subsequent call.
   * @returns true while the socket is open.
   */
  isAlive(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  async whenReady(deadline = Date.now() + 30_000): Promise<void> {
    const timeoutMs = Math.max(1, deadline - Date.now())
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`dsh-builtin-browser: the browser did not complete the CDP handshake within ${timeoutMs / 1000}s`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async whenClosed(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => this.socket.addEventListener('close', () => resolve(), { once: true }))
  }

  /**
   * Send one CDP command, optionally on an attached session.
   * @param method - the CDP method.
   * @param params - its parameters.
   * @param sessionId - the flattened session to target, when this is a page command.
   * @returns the CDP result.
   */
  async send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = 30_000): Promise<unknown> {
    // Fail fast and say why. Waiting out the timeout on a closed socket produced
    // only "timed out", which reads as a slow page and hides the real cause.
    if (!this.isAlive()) {
      throw new Error('dsh-builtin-browser: the browser connection is closed (the browser window was probably closed); the next command will start it again')
    }
    await this.ready
    const id = this.nextId++
    const message = { id, method, ...params !== undefined ? { params } : {}, ...sessionId !== undefined ? { sessionId } : {} }
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(message))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`dsh-builtin-browser: ${method} timed out`))
      }, timeoutMs).unref?.()
    })
  }

  /** Close the socket. */
  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }

  /** Route one CDP message to its waiter. */
  private readonly eventListeners = new Set<(method: string, params: unknown) => void>()

  /** Receive the browser's own CDP events (those without a command id). */
  onEvent(listener: (method: string, params: unknown) => void): void { this.eventListeners.add(listener) }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(raw) } catch { return }
    if (message.id === undefined) {
      const targetId = message.method === 'Target.targetDestroyed' ? (message.params as { targetId?: unknown } | undefined)?.targetId : undefined
      if (typeof targetId === 'string') this.destroyedTargets.add(targetId)
      if (typeof message.method === 'string') for (const listener of this.eventListeners) listener(message.method, message.params)
      return
    }
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`dsh-builtin-browser: CDP error: ${message.error.message ?? 'unknown'}`))
    else entry.resolve(message.result)
  }

  /** Fail everything in flight. */
  private fail(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

/** A system browser driven over CDP, presented as a browser view host. */
export class SystemBrowserViewHost implements ElectronBrowserViewHost {
  /**
   * viewId -> the session that view rides, and the client that issued it.
   *
   * The client is part of the value on purpose. A session id means nothing to a browser other
   * than the one that handed it out, and this host replaces browsers routinely: the process
   * dies, or its debugging socket closes while the process lives on. Keeping only the id meant
   * the host could start a NEW browser successfully and then send every command to it carrying
   * a session the old one had issued — `Session with given id not found`, on every call, with a
   * browser that answers /json/version perfectly well and nothing the user can do short of
   * restarting DSH. Comparing identity catches it with no round trip; validating each cached
   * session against the browser would put one on every page command.
   */
  private readonly views = new Map<string, { session: string; client: CdpClient }>()
  private disposed = false
  /**
   * The browser is started on FIRST USE, never on construction.
   *
   * A plugin that launches Chrome the moment its host loads is a plugin that takes
   * over the machine before anyone asked it to: simply starting DSH would spawn a
   * browser window. Registration must therefore be inert, and the process is only
   * spawned when a view is actually needed.
   */
  private client: CdpClient | undefined
  /** Whether the running browser was launched headless, so its pages get a plain Chrome user agent. */
  /** The browser's user agent without the `HeadlessChrome` token, read once per connection. */
  private plainUserAgent: Promise<string | undefined> | undefined
  /**
   * Set when a command went unanswered rather than being refused.
   *
   * A timeout says nothing about the connection: the page may simply be slow. It marks the
   * client for a cheap check before the next command trusts it, which keeps a slow page
   * from being mistaken for a dead browser while still catching one that has truly stopped
   * answering.
   */
  private clientSuspect = false
  private child: ChildProcess | undefined
  private launchParked = false
  private profileLease: ProfileLease | undefined
  private profileLeasing: Promise<ProfileLease> | undefined
  private starting: Promise<CdpClient> | undefined
  private lastLaunchError: string | undefined
  private launchDiagnostic: SystemBrowserLaunchDiagnostic | undefined

  /**
   * Browsers that ignored a kill.
   *
   * They are no longer this host's child — a replacement has taken that slot — but they
   * are still running, still holding the profile, and still something release must try to
   * stop. Forgetting them is what allowed a launch this host could not undo.
   */
  private readonly stubborn: ChildProcess[] = []
  private readonly ownership: BrowserProcessOwnership
  private readonly ownedClients = new WeakMap<CdpClient, ChildProcess>()
  private readonly ownedChildren = new WeakSet<ChildProcess>()
  private readonly createdTargets = new WeakMap<CdpClient, Map<string, BrowserTabWireId>>()
  private readonly browser: DetectedBrowser
  private readonly profileDir: string
  private readonly extraArgs: readonly string[]
  private readonly ephemeralDir?: string
  private readonly launcher: BrowserLauncher
  private readonly headlessMode: HeadlessMode
  private readonly isQuiet: () => boolean
  private readonly profileError?: string
  constructor(
    browser: DetectedBrowser,
    profileDir: string,
    extraArgs: readonly string[] = [],
    ephemeralDir?: string,
    launcher: BrowserLauncher = defaultLauncher,
    /**
     * Whether this launch should get a window. See {@link resolveLaunchMode} for how `auto` decides
     * and why a display-less host needs headless at all (issue #32).
     */
    headlessMode: HeadlessMode = 'auto',
    isQuiet: () => boolean = () => false,
    profileError?: string,
    ownership: ProcessOwnershipOptions = { managed: false },
  ) {
    this.browser = browser
    this.profileDir = profileDir
    this.extraArgs = extraArgs
    this.ephemeralDir = ephemeralDir
    this.launcher = launcher
    this.headlessMode = headlessMode
    this.isQuiet = isQuiet
    this.profileError = profileError
    this.ownership = new BrowserProcessOwnership(browser.path, profileDir, ownership)
  }

  private async stopChild(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true
    if (await this.ownership.terminate(child)) return true
    this.lastLaunchError = 'Cleanup refused: process ownership could not be verified; browser left running.'
    if (this.launchDiagnostic) this.launchDiagnostic.cleanup = 'ownership-unverified'
    return false
  }

  async prepare(): Promise<void> {
    try {
      await this.ensureClient()
    } catch (error) {
      const launch = this.connectionStatus().launch
      if (!(error instanceof Error) || launch === undefined) throw error
      throw Object.assign(new Error(`${error.message} Launch diagnostic: ${JSON.stringify(launch)}`, { cause: error }),
        'code' in error ? { code: error.code } : {})
    }
  }

  connectionStatus(): { connected: boolean; detail: string; launch?: SystemBrowserLaunchDiagnostic } {
    const connected = !this.disposed && this.client?.isAlive() === true && !this.clientSuspect
    return { connected, detail: connected ? 'Browser launched and connected over CDP.'
      : this.profileError ?? this.lastLaunchError ?? (this.disposed ? 'Browser carrier was released.'
        : this.starting ? 'Browser launch is in progress; no live CDP connection yet.'
          : this.client ? 'Browser CDP connection was lost or is awaiting verification.'
            : 'Browser has not launched; run a browser command to establish CDP. No live CDP connection.'),
      ...this.launchDiagnostic === undefined ? {} : { launch: {
        ...this.launchDiagnostic, devToolsActivePortPresent: existsSync(join(this.profileDir, 'DevToolsActivePort')),
      } },
    }
  }

  connectedView(id: string): boolean {
    const view = this.views.get(id), target = view === undefined ? undefined : this.sessions.get(view.session)
    return view !== undefined && target !== undefined && view.client === this.client && !view.client.headless
      && !view.client.destroyedTargets.has(target) && this.connectionStatus().connected
  }

  /**
   * Whether this view is live on the current connection but sits inside a headless browser, so there is
   * no window a person could be handed. Mirrors {@link connectedView}, which requires the opposite.
   *
   * Takeover has to tell these apart instead of falling back to the sidebar: a headless session that
   * silently produced a sidebar tab left the person acting on an unrelated page (issue #103).
   * @param id - the view to classify.
   * @returns true when the view is alive and headless.
   */
  headlessView(id: string): boolean {
    const view = this.views.get(id), target = view === undefined ? undefined : this.sessions.get(view.session)
    return view !== undefined && target !== undefined && view.client === this.client && view.client.headless
      && !view.client.destroyedTargets.has(target) && this.connectionStatus().connected
  }

  /** Which product this host would drive (for diagnostics). */
  get kind(): DetectedBrowser['kind'] {
    return this.browser.kind
  }

  /** Whether the browser has actually been started yet (diagnostics and tests). */
  get started(): boolean {
    return this.child !== undefined
  }

  /**
   * The CDP client, starting the browser on first use.
   * @returns the connected client.
   */
  /**
   * Whether a client that reports itself open is actually answering.
   *
   * An open socket proves nothing: a browser can hold the connection and never reply, and
   * that state must not be cached, or every later command waits out its own timeout. Asking
   * the browser something cheap is a fact; reading the failure text is a guess, and the
   * guess was wrong in both directions (it killed healthy browsers on a slow page, and it
   * mistook the browser's own free text for a verdict).
   *
   * This is only reached when the socket is open, so the common path costs nothing.
   * @param client - the client to question.
   * @returns true when it answered.
   */
  private async probeClient(client: CdpClient): Promise<boolean> {
    try {
      // The command budget (30s) on purpose, not a shorter "probe" value, because of what the
      // answer is used for: a false verdict discards the client and replaces the browser,
      // which KILLS the window the human is looking at. A page that is merely slow must not
      // lose its browser, so this errs toward waiting. The price is that a truly wedged
      // browser takes the full budget to be declared dead — the tool call that triggered the
      // probe answers first, and its timeout is the error the caller sees. Trading a later
      // error for a window that is not destroyed is the right way round.
      await client.send('Browser.getVersion', {})
      return true
    } catch {
      // No answer within the budget, or the socket failed while asking: unusable either way.
      return false
    }
  }

  /**
   * Forget which browser issued what, after that browser is gone.
   *
   * The two maps must move together: `views` maps a view id to a session id and `sessions`
   * maps a session id to a target id, so clearing one alone leaves a mapping the next command
   * will act on. Every path that abandons a browser calls this rather than spelling the pair
   * out — four separate copies is how the third one came to be missing.
   */
  private forgetBrowserState(): void {
    this.views.clear()
    this.sessions.clear()
    this.quietParked.clear()
    this.parkedTargets.clear()
    this.quietFront = undefined
    this.quietRevealed.clear()
    this.stopForeground()
  }

  private async ensureClient(): Promise<CdpClient> {
    // A disposed host must never start a browser: doing so would spawn a process
    // nobody owns and nobody will kill.
    if (this.disposed) throw new Error('dsh-builtin-browser: this browser host was released')
    if (this.profileError !== undefined) throw new Error(this.profileError)
    // The exit listener clears this, but a socket can also die without the process doing so
    // (the browser closing its debugging endpoint, a dropped connection). Checking the
    // socket's own state costs nothing and turns a 30s hang into a restart.
    if (this.client !== undefined) {
      // A closed socket means the browser is gone; an OPEN socket proves nothing, because
      // a browser can hold the connection and never answer. Only probe when the socket is
      // closed or a previous command went unanswered without being refused — probing every
      // call would add a round trip to the common path for nothing.
      const current = this.client
      if (current.isAlive() && !this.clientSuspect) return current
      if (current.isAlive() && await this.probeClient(current)) {
        this.clientSuspect = false
        return current
      }
      current.close()
      this.client = undefined
      this.clientSuspect = false
      // Everything this client issued dies with it. `start()` clears these too, but only
      // inside its "kill the old child" branch — and the shape of this failure usually has no
      // child left to kill: the process already exited, its exit listener already set
      // `this.child` to undefined, so start() skips that branch and publishes a new browser
      // while the views still point at the dead one. That is the state that never recovers.
      this.forgetBrowserState()
    }
    // Concurrent first calls share one startup rather than racing two browsers.
    this.starting ??= this.start().then(client => {
      this.lastLaunchError = undefined
      return client
    }).catch(error => {
      this.lastLaunchError = error instanceof Error ? error.message : String(error)
      throw error
    }).finally(() => { this.starting = undefined })
    return await this.starting
  }

  /**
   * Take over a browser already serving this profile, instead of racing it.
   *
   * A previous DSH process leaves its browser running: the child handle died with that process, so
   * nothing here knows about it, and `start()`'s cleanup branch is skipped because it keys on
   * `this.child`. Launching then does something worse than fail — on Windows Chrome hands the
   * request to the instance already holding the profile and exits 0, and that exit is read as a
   * launch failure. The user is told to go kill the leftovers by hand, on every restart, which is
   * exactly what was reported.
   *
   * The launch loop deliberately refuses to trust a `<profile>/DevToolsActivePort` left by a
   * previous launch, and it is right to: a stale port number can be reused by something that is
   * not a browser at all. What makes adoption safe HERE is that this runs BEFORE launching, on a
   * file that lives inside this plugin's own profile directory — only a browser started with this
   * `--user-data-dir` writes it — and the endpoint is then asked to identify itself.
   * @param _why - a short phrase for the log, naming which attempt this is.
   * @returns a connected client for the running browser, or undefined when there is none.
   */
  private async adoptRunningBrowser(_why: string, explicitPort?: number, deadline = Date.now() + 30_000): Promise<CdpClient | undefined> {
    const portFile = join(this.profileDir, 'DevToolsActivePort')
    let port: number
    if (typeof explicitPort === 'number' && explicitPort > 0) {
      port = explicitPort
    } else try {
      if (!existsSync(portFile)) return undefined
      const value = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? '')
      if (!Number.isInteger(value) || value <= 0) return undefined
      port = value
    } catch {
      return undefined
    }
    let client: CdpClient | undefined
    let identified = false
    try {
      const version = await (await fetch(cdpVersionUrl(port), {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })).json() as { webSocketDebuggerUrl?: string; Browser?: string }
      if (typeof version.webSocketDebuggerUrl !== 'string') return undefined
      // The port number alone proves nothing — it can be reused once the browser that owned it
      // exits. The endpoint's own answer is the evidence, and it has to name a browser.
      if (!isBrowserProduct(version.Browser)) return undefined
      identified = true
      client = new CdpClient(version.webSocketDebuggerUrl)
      await client.whenReady(deadline)
      // Asked through the protocol too, so a websocket that merely accepts connections is not
      // mistaken for a browser that answers.
      const info = await client.send('Browser.getVersion', {}, undefined, Math.max(1, deadline - Date.now())) as { product?: string }
      if (!isBrowserProduct(info?.product) || info.product !== version.Browser) throw new Error('browser did not acknowledge its identity')
      client.headless = /^HeadlessChrome\//u.test(info.product ?? '')
      if (this.disposed) { client.close(); return undefined }
      await client.send('Target.setDiscoverTargets', { discover: true }, undefined, Math.max(1, deadline - Date.now()))
      if (this.disposed || Date.now() >= deadline) { client.close(); return undefined }
      this.launchParked = false
      this.client = client
      this.placeOpenedWindows(client)
      this.plainUserAgent = undefined
      return client
    } catch (error) {
      client?.close()
      if (identified) throw error
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error('browser did not acknowledge its discovery endpoint before the launch deadline', { cause: error })
      }
      // No endpoint, nothing listening, or not a browser: all of them mean "launch one".
      return undefined
    }
  }

  /**
   * Launch the browser with a private profile and connect over CDP.
   *
   * `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the only
   * reliable way to learn the port: a fixed port collides with whatever else the
   * machine is running, and parsing stderr is fragile across versions.
   * @returns the connected client.
   */
  private async start(): Promise<CdpClient> {
    const deadline = Date.now() + 30_000
    if (this.profileLease === undefined) {
      const lease = await (this.profileLeasing ??= acquireProfileLease(this.profileDir).finally(() => { this.profileLeasing = undefined }))
      if (this.disposed) { await lease.release(); throw new Error('dsh-builtin-browser: the browser host was disposed while launching') }
      this.profileLease = lease
    }
    // Before spawning anything: is a browser for THIS profile already running? A DSH restart
    // leaves one behind, and launching into it is the failure reported as "exited immediately
    // after launch (exit code 0)" that required killing seven processes by hand.
    // A browser the human started with an explicit debugging port. Port 0 makes Chromium write the chosen
    // port into the profile, which the probe below already finds; an explicit port leaves no file, so this
    // is the only way to reach it. Attaching means driving the window they already have open.
    const explicitPort = Number(process.env.DSH_BROWSER_ATTACH_PORT ?? '')
    const attached = Number.isSafeInteger(explicitPort) && explicitPort > 0
      ? await this.adoptRunningBrowser('explicit attach port', explicitPort, deadline) : undefined
    if (attached !== undefined) {
      ;(globalThis as unknown as Record<string, unknown>).__dshBrowserCarrier = 'attached'
      return attached
    }
    const adopted = await this.adoptRunningBrowser('before launch', undefined, deadline)
    if (adopted !== undefined) return adopted
    // Whether a window exists is decided by `browser.headless` ALONE (plus the operator's
    // DSH_BROWSER_HEADLESS override inside resolveLaunchMode). `ui.quiet` must not force
    // headless: it describes how the agent presents its work — no activation, no raising,
    // background targets — not whether the human is allowed to see a browser at all.
    // Overriding the setting here made an explicit `headless: windowed`/`headed` invisible on
    // Chrome/Edge, so the human could not take over a login or a challenge, and an already
    // headless process cannot become visible by toggling quiet later. Quiet still governs
    // presentView() and createTarget() below, which is where activation belongs.
    const launch = resolveLaunchMode(this.headlessMode)
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      // Behave like a fresh, unattended browser: no first-run UI, no default-browser
      // prompt, no restore bubble, and no "Chrome is being controlled" infobar.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      // The remote-debugging port this plugin drives makes Chrome set `navigator.webdriver` on every
      // page, windowed or not, which bot walls read as "a script, not a person" — even while the
      // person is the one browsing. Chrome's own switch turns that marker off; nothing else changes.
      '--disable-blink-features=AutomationControlled',
      // Quiet mode parks its first window off-screen; without these Windows occlusion tracking marks
      // it hidden, pausing rAF, clamping timers and stalling screenshots. Passed always: quiet is a live setting.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // Headless only where there is nothing to draw on. `--headless=new` rather than the legacy
      // flag: the new mode behaves like a windowed browser, which matters because every command
      // here was written and measured against one — including CDP input, which Chromium silently
      // drops for a view it believes has no display surface. `--disable-gpu` and
      // `--disable-dev-shm-usage` are what make that mode usable on a server: no GPU, and a
      // /dev/shm far smaller than a desktop. See resolveLaunchMode for why this is conditional.
      ...launch.headless ? ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage'] : [],
      ...this.extraArgs,
      // NOT `about:blank`. Every page this plugin drives is created by `Target.createTarget` when a
      // session first needs one (`buildSession`, which adopts a blank if the browser opened one and
      // creates one otherwise), so a startup page is a tab nobody asked for and nobody closes: the
      // tab strip showed `about:blank` next to the real page while `dsh_browser_list_tabs` reported
      // only the real one. Reported as issue #33, banner and all.
      //
      // `--no-startup-window` keeps the browser alive with no window and no initial page; measured
      // by the reporter on Chrome 156 as writing DevToolsActivePort in 599 ms, answering
      // `/json/version`, listing two extension targets and no page, and then creating windows
      // normally through `Target.createTarget`.
      '--no-startup-window',
    ]
    // Chromium shows a new window at its default spot and only then applies Target.createTarget's
    // left/top, so a quiet first window flashed on-screen; the launch position is applied before show.
    this.launchParked = !launch.headless && this.isQuiet()
    if (this.launchParked) args.push(`--window-position=${QUIET_PARK.left},${QUIET_PARK.top}`, `--window-size=${QUIET_PARK.width},${QUIET_PARK.height}`)
    if (launch.headless) {
      process.stderr.write(`[dsh-browser] launching headless (${launch.why}); `
        + 'the browser has no window but every tool works the same\n')
    }
    // A browser from a previous attempt may still be running with this same
    // --user-data-dir. On Windows the new one would merely hand off to it and exit, and that
    // exit would then be treated as the launch failing.
    if (this.child !== undefined) {
      const dying = this.child
      if (!await this.stopChild(dying)) throw new Error(this.lastLaunchError)
      this.child = undefined

      // Whatever the old browser issued is worthless now, and its exit listener cannot clean
      // up after itself: this.child is reassigned below, so the old child's exit event returns
      // early and the session ids it handed out would be reused against a browser that never
      // heard of them — the "Session with given id not found" loop, which never clears.
      this.client?.close()
      this.client = undefined
      this.forgetBrowserState()

      // Wait for it to actually die. kill() only sends the signal: on Windows it is
      // TerminateProcess, which is asynchronous, and the browser may still hold this profile's
      // singleton lock for a while. Spawning immediately meant the replacement saw an existing
      // instance, handed its command line over and exited — and that exit was then reported as
      // "check that the path is a runnable browser", blaming the user's install for a race this
      // code created. Bounded, because a process that refuses to die must not hang the call.
      await new Promise<void>(resolve => {
        if (dying.exitCode !== null || dying.signalCode !== null) { resolve(); return }
        const done = (): void => { clearTimeout(timer); resolve() }
        const timer = setTimeout(done, EXIT_GRACE_MS)
        dying.once('exit', done)
        // It did not exit in time. Dropping the reference here was how this host could
        // launch a browser it could never kill again: dispose() only knows about this.child,
        // and this process still holds the profile's singleton lock. Remember it so release
        // still reaches it.
        if (dying.exitCode === null && dying.signalCode === null) this.stubborn.push(dying)
        dying.once('exit', () => {
          const at2 = this.stubborn.indexOf(dying)
          if (at2 !== -1) this.stubborn.splice(at2, 1)
        })
      })
      if (dying.exitCode === null && dying.signalCode === null) throw new Error('dsh-builtin-browser: the previous browser still holds this profile; refusing another launch')
    }
    // The port file is deliberately NOT deleted here, and that is a reversal.
    //
    // It used to be removed so the launch loop below could not read a previous browser's port. But
    // the loop judges freshness against a snapshot taken below, so the deletion never protected it
    // — while it DID destroy the only record of a browser that may still be running for this
    // profile. That record is what `adoptRunningBrowser` needs when the launch comes back as a
    // hand-off: the browser was alive the whole time, and without the file there is no way to find
    // it again.
    const portFile = join(this.profileDir, 'DevToolsActivePort')
    /**
     * What the port file was like BEFORE this launch, so "fresh" is judged against a snapshot
     * rather than against a clock.
     *
     * The test used to be `mtimeMs < spawnedAt` — a filesystem timestamp compared to `Date.now()`.
     * Those are different clocks with different resolutions, and CI is where it showed: a file the
     * fake browser had just written was rejected as stale, so the loop waited out its full 30s
     * against a browser that was already listening, because the file's mtime had rounded down
     * below the spawn time. That is not a test-only problem: on any filesystem whose mtime
     * resolution is coarser than a millisecond, the plugin would fail to see the browser it had
     * just launched, and report a CDP timeout for a browser that was up the whole time.
     *
     * `undefined` means there was no file, so any file that appears afterwards is fresh. When one
     * existed, a later mtime OR different contents makes the new one fresh. Byte-identical contents
     * with an unchanged mtime is the PREVIOUS browser's port, and adopting it is what this whole
     * check exists to prevent: it may name a port that now belongs to something else entirely.
     */
    const portFileBefore = ((): { mtimeMs: number; contents: string } | undefined => {
      try {
        return { mtimeMs: statSync(portFile).mtimeMs, contents: readFileSync(portFile, 'utf8') }
      } catch {
        return undefined
      }
    })()
    let child: ReturnType<typeof spawn>
    if (this.disposed || Date.now() >= deadline) throw new Error('dsh-builtin-browser: launch was cancelled or its deadline expired')
    const launchDiagnostic: SystemBrowserLaunchDiagnostic = {
      stderrTail: '', exitCode: null, signal: null, devToolsActivePortPresent: existsSync(portFile),
    }
    this.launchDiagnostic = launchDiagnostic
    try {
      child = this.launcher(this.browser.path, args)
    } catch (error) {
      // spawn throws synchronously for some targets (a .cmd on Windows, a path that cannot
      // be executed). Without this the exception escaped start() and skipped every
      // diagnostic below it.
      throw new Error(`dsh-builtin-browser: could not launch ${this.browser.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.child = child
    launchDiagnostic.exitCode = child.exitCode
    launchDiagnostic.signal = child.signalCode
    child.on('exit', (code, signal) => {
      launchDiagnostic.exitCode = code ?? child.exitCode
      launchDiagnostic.signal = signal ?? child.signalCode
    })
    /**
     * A launch that fails (ENOENT, no permission, a broken binary) is reported by an
     * asynchronous 'error' event on the child, NOT by a throw here and NOT by exitCode.
     * Without this listener Node treats it as unhandled and takes the whole host process
     * down — one bad browser path would kill DSH, not just fail a tool call.
     */
    let launchError: Error | undefined
    let diagnostic = ''
    child.stderr?.on('data', chunk => {
      diagnostic = (diagnostic + String(chunk)).slice(-4096)
      launchDiagnostic.stderrTail = diagnosticTail(diagnostic)
      if (/remote debugging requires a non-default data directory/iu.test(diagnostic)) {
        launchError = new Error('The browser refused remote debugging on its default user profile. A live CDP connection is required; no alternative profile was substituted.')
      }
    })
    child.on('error', error => {
      launchError = error
      launchDiagnostic.exitCode = child.exitCode
      launchDiagnostic.signal = child.signalCode
    })
    // A browser that exits later is as unusable as one that never started, and the failure
    // has to reach the NEXT call rather than being swallowed: clearing the client here is
    // what makes ensureClient() start a fresh browser instead of returning a socket to a
    // dead process and letting every command time out.
    child.on('exit', () => {
      if (this.child !== child) return
      this.client?.close()
      this.client = undefined
      this.child = undefined
      this.lastLaunchError = 'Browser exited; the CDP connection is no longer live.'
      // The pages this client opened belong to the process that just died; keeping their
      // session ids means every later command is sent to a browser that never issued them.
      // Clearing these is what makes the restart usable rather than merely alive.
      this.forgetBrowserState()
    })
    await this.ownership.capture(child)
    /**
     * The port this launch wrote, or undefined while it has not written one yet.
     *
     * A file left by the PREVIOUS browser is not evidence about this one. Its contents name a port
     * that may now belong to something else entirely — another Chromium, a `node --inspect` — and
     * connecting there publishes a client this host does not own and dispose() can never kill.
     * Only a file that CHANGED across this launch counts, which is what `portFileBefore` records.
     */
    const freshPort = (): number | undefined => {
      try {
        if (!existsSync(portFile)) return undefined
        const after = statSync(portFile)
        const contents = readFileSync(portFile, 'utf8')
        // Unchanged since before the launch: this is the previous browser's file, whatever its
        // mtime says. Comparing against the snapshot rather than a wall-clock instant is what
        // keeps this correct on a filesystem whose timestamps are coarser than a millisecond.
        if (portFileBefore !== undefined
          && after.mtimeMs <= portFileBefore.mtimeMs
          && contents === portFileBefore.contents && child.exitCode !== 0) return undefined
        const value = Number(contents.split('\n')[0]?.trim() ?? '')
        return Number.isInteger(value) && value > 0 ? value : undefined
      } catch {
        return undefined
      }
    }
    /**
     * Why the loop stopped, so the failure can say what actually happened. Reporting
     * every ending as "did not expose CDP within 30s" was wrong three ways: the cause,
     * the words, and the elapsed time — a browser that cannot be launched says so in
     * half a second, and the caller then looks for a CDP problem that does not exist.
     */
    let stopped: 'released' | 'timeout' | 'exited' | 'launch-failed' = 'timeout'
    for (;;) {
      // Released while we were starting: stop here rather than keep polling for a
      // browser that dispose() has already killed, which would leave a connection
      // to a dead process behind. The child is killed here too — dispose() may have
      // run before this child was recorded, leaving nobody else to do it.
      if (this.disposed) { await this.stopChild(child); if (this.child === child) this.child = undefined; stopped = 'released'; break }
      if (launchError !== undefined) { if (this.child === child) this.child = undefined; stopped = 'launch-failed'; break }
      if (Date.now() > deadline) { await this.stopChild(child); stopped = 'timeout'; break }
      // signalCode too: a browser killed by a signal never sets exitCode, so checking exitCode
      // alone made a killed browser look alive and the launch run out its full 30s deadline
      // before reporting "did not expose CDP" — a timeout for something that died at once.
      // The sibling check on the release path already looked at both.
      if (child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0)) { if (this.child === child) this.child = undefined; stopped = 'exited'; break }
      // Only a port THIS launch wrote: reading whatever file happened to be there is how a
          // restart could adopt the previous browser, or any process now holding that port.
          const port = freshPort()
          if (port !== undefined) {
        try {
            const version = await (await fetch(cdpVersionUrl(port), {
              // Bounded: an unanswered loopback request would otherwise park inside this
              // iteration for the rest of the budget, and the deadline above is only re-checked
              // between iterations. Deliberately no larger than the 250 ms sleep — see
              // PORT_PROBE_MS.
              signal: AbortSignal.timeout(Math.max(1, Math.min(PORT_PROBE_MS, deadline - Date.now()))),
            })).json() as { webSocketDebuggerUrl?: string; Browser?: string }
            if (typeof version.webSocketDebuggerUrl === 'string') {
              const client = new CdpClient(version.webSocketDebuggerUrl)
              // `whenReady` has its own 30 s ceiling, and it is reached only after the port
              // answered above — so the browser is listening and this is a handshake, not a
              // discovery. A handshake that outlives the launch is reported as the timeout it
              // is, by the same deadline that governs everything else here.
              try {
                await client.whenReady(deadline)
                const info = await client.send('Browser.getVersion', {}, undefined, Math.max(1, deadline - Date.now())) as { product?: string }
                if (typeof info.product !== 'string' || info.product === '' || info.product !== version.Browser) throw Object.assign(new Error('browser did not acknowledge its identity'), { code: 'BROWSER_LAUNCH_UNACKNOWLEDGED' })
                await client.send('Target.setDiscoverTargets', { discover: true }, undefined, Math.max(1, deadline - Date.now()))
              } catch (error) { client.close(); throw error }
              // Still wanted? A dispose() during the handshake has already killed the
              // process, so publishing the client would leave a dangling connection.
              if (this.disposed || Date.now() >= deadline) { client.close(); break }
              if (await this.ownership.verify(child)) {
                try {
                  const processes = await client.send('SystemInfo.getProcessInfo', {}, undefined, 1000) as { processInfo?: { type: string; id: number }[] }
                  if (processes.processInfo?.some(entry => entry.type === 'browser' && entry.id === child.pid)
                    && await this.ownership.verify(child)) {
                    this.ownedClients.set(client, child)
                    this.ownedChildren.add(child)
                  }
                } catch { /* An unidentified endpoint is borrowed, never owned. */ }
              }
              if (this.disposed) { client.close(); break }
              client.headless = launch.headless
              this.client = client
              this.placeOpenedWindows(client)
              this.plainUserAgent = undefined
              return client
            }
        } catch (error) {
          if ((error as { code?: string })?.code === 'BROWSER_LAUNCH_UNACKNOWLEDGED') throw error
          // The file can exist a moment before the port answers; poll again.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    // Each ending gets its own message. The old single message blamed a CDP timeout for
    // all of them, which sent the reader looking for a port problem when the browser had
    // simply failed to launch.
    const target = `${this.browser.kind} (${this.browser.path})`
    if (stopped === 'launch-failed') {
      throw new Error(`dsh-builtin-browser: could not launch ${target}: ${launchError?.message ?? 'unknown error'}`)
    }
    if (stopped === 'exited') {
      // Only exit code 0 is the hand-off story. A non-zero code or a signal means the browser
      // died on its own — a crash, a missing library, a sandbox refusal — and asserting the
      // profile story for those sent people looking for a leftover process that was not there,
      // which is the same mistake this message was written to correct, pointing the other way.
      const code = child.exitCode
      const signal = child.signalCode
      throw new Error(
          `dsh-builtin-browser: ${target} exited immediately after launch `
            + `(${signal !== null ? `killed by ${signal}` : `exit code ${String(code)}`}), so it did not `
            + 'hand the request anywhere — the browser failed to start rather than deferring to another '
            + 'instance. Check that it can run at all: run it by hand, and look for a crash or a missing '
            + 'dependency rather than a leftover process.',
      )
    }
    if (stopped === 'released') {
      throw new Error(`dsh-builtin-browser: ${target} was released while it was starting`)
    }
    throw new Error(`dsh-builtin-browser: ${target} did not expose CDP within 30s. `
      + (child.exitCode === 0 && !existsSync(portFile)
        ? 'The launcher exited successfully without DevToolsActivePort; it may have handed off to an already-running browser without debugging enabled. '
        : 'The selected profile did not provide a live debugging endpoint. ')
      + 'No alternative browser profile was substituted.')
  }

  /**
   * Whether this host can back views.
   *
   * True while the host is usable — including before the browser has been started,
   * since the first command is what starts it. Reporting "unavailable" here would
   * make the plugin fall back for no reason.
   */
  available(): boolean {
    return !this.disposed
  }

  /**
   * Every page the browser holds that THIS HOST did not open.
   *
   * Chrome and Edge own their own page creation. A click on a link that opens a new page — or any
   * `window.open` — produces a page the provider never asked for, and nothing reports it back.
   * Those pages are real: they hold memory and stay until something closes them. Measured on a real
   * window: four pages present while `dsh_browser_list_tabs` reported one.
   *
   * Pages this host opened are EXCLUDED here rather than deduplicated by the caller, because the
   * caller cannot do it: the provider knows a tab by its own id, the carrier knows a page by its
   * CDP target id, and the two never match. The first version returned everything and relied on the
   * caller to filter, which reported the same page twice.
   *
   * Discovery is enabled before the connection is published, so
   * `Target.getTargets` also lists pages that existed before this client connected.
   * @returns the browser's pages that are not ours, or an empty list when it cannot answer.
   */
  async listPages(
    // The installed browser is one shared instance, not a per-conversation
    // panel, so ownership does not scope its listing.
    scope: BrowserSessionWireId,
    options: { readonly requireRunning?: boolean } = {},
  ): Promise<readonly CarrierPage[]> {
    // Looking for a page must never START the human's browser. Before this
    // check the reference-bar pump called listPages on every tick, whose
    // ensureClient() launched Edge on its own within seconds of the plugin
    // loading — measured with no open/navigate call at all.
    const liveClient = this.client
    if (options.requireRunning === true && (this.disposed || liveClient === undefined || !liveClient.isAlive())) return []
    try {
      const client = options.requireRunning === true && liveClient !== undefined ? liveClient : await this.ensureClient()
      const listed = await client.send('Target.getTargets', {}) as {
        targetInfos?: Array<{ targetId?: string; type?: string; url?: string; title?: string }>
      }
      const ours = new Set(this.sessions.values())
      return (listed?.targetInfos ?? [])
        .filter(entry => entry.type === 'page' && typeof entry.targetId === 'string')
        .filter(entry => !/^edge:\/\/sync-confirmation-dialog(?:\/|$)/.test(entry.url ?? ''))
        .filter(entry => !ours.has(entry.targetId as string))
        .map(entry => ({
          id: tabWireId({ ...resolveSessionHandle(scope), tab: `page:${entry.targetId as string}` }),
          url: typeof entry.url === 'string' ? entry.url : '',
          ...typeof entry.title === 'string' && entry.title !== '' ? { title: entry.title } : {},
        }))
    } catch {
      // A listing must not fail harder than driving does; the next command reports a real problem.
      return []
    }
  }

  /**
   * Close one page by the target id {@link listPages} reported.
   *
   * Only targets created by this owner/session on this connection may be closed.
   * @param id - the CDP target id.
   */
  async closePage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<void> {
    const identity = resolveTabHandle(resolveSessionHandle(scope), id)
    const view = this.views.get(id)
    if (view === undefined && !identity.tab.startsWith('page:')) return
    const client = await this.ensureClient()
    const targetId = view === undefined ? identity.tab.replace(/^page:/, '') : this.sessions.get(view.session)
    if (targetId === undefined) throw new Error('dsh-builtin-browser: browser page is stale')
    const creator = this.createdTargets.get(client)?.get(targetId)
    if (creator === undefined) throw new Error('dsh-builtin-browser: personal or adopted tabs are detach-only; close the tab in the browser')
    resolveTabHandle(resolveSessionHandle(scope), creator)
    const answer = await client.send('Target.closeTarget', { targetId }) as { success?: boolean }
    if (answer.success !== true) throw new Error('dsh-builtin-browser: browser close was not acknowledged')
    this.createdTargets.get(client)?.delete(targetId)
  }

  createView(identity?: BrowserTabWireId): ElectronViewHandle {
    const viewId = identity ?? tabWireId({ owner: 'standalone', session: randomUUID(), tab: randomUUID() })
    readTabHandle(viewId)
    return {
      id: viewId,
      // This is the real browser, not Electron: CDP's JPEG encoder works here, so the
      // provider may pass format and quality through instead of falling back to PNG.
      supportsCdpJpeg: true,
      sendCommand: async (method: string, params?: Record<string, unknown>, options?: CommandOptions) => {
      if (method === 'Browser.close' || method === 'Target.closeTarget' || method === 'Page.close') {
        throw new Error('dsh-builtin-browser: use explicit tab close; browser-wide and unowned-tab closes are not allowed')
      }
      // Background probes (reference bar pump, readiness checks) pass initialize: false and
      // must never relaunch a killed browser or recreate a tab the user closed (issue #105).
      const initialize = options?.initialize !== false
      let client: CdpClient
      if (initialize) {
        client = await this.ensureClient()
      } else {
        const liveClient = this.client
        if (this.disposed || liveClient === undefined || !liveClient.isAlive()) {
          throw new Error('dsh-builtin-browser: browser is not running')
        }
        client = liveClient
      }
      const cachedView = this.views.get(viewId)
      if (cachedView !== undefined && cachedView.client === client) {
        const cachedTarget = this.sessions.get(cachedView.session)
        if (cachedTarget !== undefined && client.destroyedTargets.has(cachedTarget)) {
          this.views.delete(viewId)
          this.sessions.delete(cachedView.session)
          if (!initialize) throw new Error('dsh-builtin-browser: target was closed')
        }
      }
      // A session belongs to the browser that issued it. Clearing the cache whenever a client is
      // dropped covers the ordinary case, but not this one: another call can be inside
      // ensureSession() holding the OLD client while this one discards it and clears, and that
      // call's `views.set` then lands afterwards — re-adding an entry naming a browser that is
      // gone. The identity check is what refuses it, and it costs a comparison rather than the
      // round trip that validating every cached session against the browser would cost.
      const liveView = this.views.get(viewId)
      if (!initialize && (liveView === undefined || liveView.client !== client)) {
        throw new Error('dsh-builtin-browser: view has no live page')
      }
      const session = liveView !== undefined && liveView.client === client
        ? liveView.session
        : await this.ensureSession(viewId)
      /**
       * Send one page command, rebuilding the attach once if the browser no longer knows the
       * session. Re-attaches to the original live target instead of spawning a blank page,
       * never rebuilds a target that was destroyed or closed by the user, and never initializes
       * a new page when `initialize: false` (issue #105).
       */
      const sendWithAttach = async (target: string): Promise<Record<string, unknown>> => {
        try {
          const result = await client.send(method, params, target)
          return (result ?? {}) as Record<string, unknown>
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/Session with given id not found|No session with given id/i.test(message)) throw error
          // If another concurrent call already started or finished reattaching this view, join it
          // instead of falling through to ensureSession() and spawning an orphan about:blank tab.
          const inFlight = this.sessionBuilding.get(viewId)
          if (inFlight !== undefined) {
            if (!initialize) throw error
            const joined = await inFlight
            const retried = await client.send(method, params, joined)
            return (retried ?? {}) as Record<string, unknown>
          }
          const current = this.views.get(viewId)
          if (current !== undefined && current.client === client && current.session !== target) {
            const retried = await client.send(method, params, current.session)
            return (retried ?? {}) as Record<string, unknown>
          }
          // Drop only the stale mapping for this exact client+session.
          if (current !== undefined && current.client === client && current.session === target) {
            this.views.delete(viewId)
          }
          const deadTarget = this.sessions.get(target)
          this.sessions.delete(target)
          if (!initialize) throw error
          if (deadTarget !== undefined) {
            if (client.destroyedTargets.has(deadTarget)) throw error
            // Register the reattach transaction synchronously before any await so concurrent
            // callers hitting the same stale session join it instead of spawning about:blank.
            const rebuilt = await this.reattachTarget(client, viewId, deadTarget)
            const retried = await client.send(method, params, rebuilt)
            return (retried ?? {}) as Record<string, unknown>
          }
          const rebuilt = await this.ensureSession(viewId)
          const retried = await client.send(method, params, rebuilt)
          return (retried ?? {}) as Record<string, unknown>
        }
      }
      try {
        return await sendWithAttach(session)
        } catch (error) {
          if (error instanceof Error && /timed out/.test(error.message)) this.clientSuspect = true
          if (!client.isAlive()) {
            if (this.client === client) {
              this.client = undefined
              this.forgetBrowserState()
            }
            client.close()
          }
          throw error
      }
      },
    }
  }

  destroyView(handle: ElectronViewHandle, _options?: { readonly keepPage?: boolean }): void {
    const cachedView = this.views.get(handle.id)
    this.views.delete(handle.id)
    if (cachedView === undefined) return
    const session = cachedView.session
    const targetId = this.sessions.get(session)
    this.sessions.delete(session)
    // Nothing to close if the browser was never started.
    if (targetId !== undefined && this.client !== undefined) {
      void cachedView.client.send('Target.detachFromTarget', { sessionId: session }).catch(() => undefined)
    }
  }

  /** Nothing to show: the browser owns its own windows. */
  showView(handle: ElectronViewHandle, _label?: string, options?: { readonly quiet?: boolean; readonly select?: boolean; readonly user?: boolean }): void {
    if (options?.user === true && (options.quiet === true || this.isQuiet())) void this.revealQuietWindow(handle, { select: true })
  }

  /**
   * Bring the target's page to the front, then report success.
   *
   * A failure is swallowed rather than propagated: a real Chrome window that refuses to come
   * forward is not a reason to refuse the click that follows. The barrier exists to order the
   * two, and the order is honoured either way.
   * @param handle - the view to present.
   */
  async presentView(handle: ElectronViewHandle, _label?: string, options?: { readonly quiet?: boolean; readonly select?: boolean; readonly user?: boolean }): Promise<void> {
    if (options?.quiet === true || this.isQuiet()) {
      if (options?.user === true) await this.revealQuietWindow(handle, { select: true })
      return
    }
    try {
      await handle.sendCommand('Page.bringToFront')
    } catch {
      // Backgrounded, minimised, or a target that went away between the snapshot and the
      // click. The command that called this will report its own failure if the page is gone.
    }
  }

  /**
   * Best effort at bringing the browser's window forward.
   */
  async focus(): Promise<void> {
    if (this.child && await this.ownership.verify(this.child)) {
      try { this.child.kill('SIGCONT') } catch { /* Windows has no SIGCONT. */ }
    }
  }

  /**
   * Close the browser we launched, if we ever launched one.
   */
  dispose(): void {
    this.stopForeground()
    if (this.disposed) return
    this.disposed = true
    const client = this.client
    this.forgetBrowserState()
    this.client = undefined
    const disconnect = async (): Promise<void> => {
      if (!client) return
      const owner = this.ownedClients.get(client)
      try {
        if (owner && await this.ownership.verify(owner)) {
          const result = await client.send('SystemInfo.getProcessInfo', {}, undefined, 1000) as { processInfo?: { type: string; id: number }[] }
          if (result.processInfo?.some(entry => entry.type === 'browser' && entry.id === owner.pid)
            && await this.ownership.verify(owner)) await client.send('Browser.close', {}, undefined, 1000)
        }
      } catch { /* An unverified endpoint is detach-only. */ }
      finally { client.close() }
    }
    void disconnect()
    const doomed = [this.child, ...this.stubborn.splice(0)].filter(
      (entry): entry is ChildProcess => entry !== undefined,
    )
    this.child = undefined
    for (const dying of doomed) {
      const force = (): void => { void this.stopChild(dying) }
      const timer = setTimeout(force, CLOSE_GRACE_MS)
      timer.unref?.()
      dying.once('exit', () => { clearTimeout(timer) })
    }
    const ephemeral = this.ephemeralDir
    const cleanup = (): void => {
      void (async () => {
        const removeProfile = (): void => {
          if (ephemeral !== undefined && doomed.length > 0 && doomed.every(child => this.ownership.ownsDirectory(child, ephemeral) && this.ownedChildren.has(child)
            && (child.exitCode !== null || child.signalCode !== null))) rmSync(ephemeral, { recursive: true, force: true })
        }
        if (this.profileLease !== undefined) await this.profileLease.release(removeProfile)
        else removeProfile()
        this.profileLease = undefined
      })().catch(error => process.stderr.write(`[dsh-browser] profile release failed: ${String(error)}\n`))
    }
    const live = doomed.filter(child => child.exitCode === null && child.signalCode === null)
    if (live.length > 0) {
      const remaining = new Set(live)
      for (const child of live) child.once('exit', () => {
        remaining.delete(child)
        if (remaining.size === 0) cleanup()
      })
    } else if (client !== undefined) {
      void client.whenClosed().then(cleanup)
    } else {
      cleanup()
    }
  }

  /**
   * Verify an existing target is still alive and re-attach to it, sharing one in-flight transaction
   * across concurrent callers for the same view and never creating a replacement blank page.
   */
  private async reattachTarget(client: CdpClient, viewId: string, targetId: string): Promise<string> {
    const existing = this.views.get(viewId)
    if (existing !== undefined && existing.client === client) return existing.session
    const inFlight = this.sessionBuilding.get(viewId)
    if (inFlight !== undefined) return await inFlight
    const building = (async (): Promise<string> => {
      if (client.destroyedTargets.has(targetId)) {
        throw new Error('dsh-builtin-browser: CDP error: Session with given id not found.')
      }
      const alive = await client.send('Target.getTargets', {})
        .then(listed => Array.isArray((listed as { targetInfos?: unknown }).targetInfos)
          ? (listed as { targetInfos: Array<{ targetId?: unknown }> }).targetInfos.some(entry => entry.targetId === targetId)
          : true)
        .catch(() => true)
      if (!alive) {
        throw new Error('dsh-builtin-browser: CDP error: Session with given id not found.')
      }
      const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
      const sessionId = attached?.sessionId
      if (typeof sessionId !== 'string') {
        throw new Error(`dsh-builtin-browser: could not reattach to existing page ${targetId}`)
      }
      await this.presentAsChrome(client, sessionId)
      this.sessions.set(sessionId, targetId)
      this.views.set(viewId, { session: sessionId, client })
      return sessionId
    })().finally(() => {
      this.sessionBuilding.delete(viewId)
    })
    this.sessionBuilding.set(viewId, building)
    return await building
  }

  /**
   * The flattened session for a view, creating its page on first use.
   */
  private async ensureSession(viewId: string): Promise<string> {
    const inFlight = this.sessionBuilding.get(viewId)
    if (inFlight !== undefined) return await inFlight
    const building = this.buildSession(viewId).finally(() => {
      this.sessionBuilding.delete(viewId)
    })
    this.sessionBuilding.set(viewId, building)
    return await building
  }

  /** Create and attach the target for one view. Serialised by {@link ensureSession}. */
  private async buildSession(viewId: string): Promise<string> {
    const client = await this.ensureClient()
    const previous = this.targetBuilds.get(client) ?? Promise.resolve()
    let release!: () => void
    const building = new Promise<void>(resolve => { release = resolve })
    this.targetBuilds.set(client, building)
    await previous
    try {
      const adopted = await this.adoptBlankTarget(client)
      const targetId = adopted ?? await this.createTarget(client, viewId)
      const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
      const sessionId = attached?.sessionId
      if (typeof sessionId !== 'string') throw new Error('dsh-builtin-browser: the browser did not attach to the new page')
      if (adopted !== undefined) this.rememberTarget(client, targetId, viewId)
      await this.clearDisplays(client, sessionId, targetId)
      await this.presentAsChrome(client, sessionId)
      this.sessions.set(sessionId, targetId)
      this.views.set(viewId, { session: sessionId, client })
      return sessionId
    } finally {
      release()
      if (this.targetBuilds.get(client) === building) this.targetBuilds.delete(client)
    }
  }

  private async presentAsChrome(client: CdpClient, sessionId: string): Promise<void> {
    this.plainUserAgent ??= (client.send('Browser.getVersion', {}) as Promise<{ userAgent?: string }>)
      .then(info => typeof info?.userAgent === 'string' && info.userAgent.includes('HeadlessChrome/')
        ? info.userAgent.replace(/HeadlessChrome\//u, 'Chrome/') : undefined, () => undefined)
    const userAgent = await this.plainUserAgent
    if (userAgent === undefined) return
    await client.send('Emulation.setUserAgentOverride', { userAgent }, sessionId).catch(() => {})
  }

  async adoptPage(identity: BrowserTabWireId, scope = sessionWireId(readTabHandle(identity))): Promise<ElectronViewHandle> {
    const tab = resolveTabHandle(resolveSessionHandle(scope), identity).tab
    if (!tab.startsWith('page:')) throw new Error('dsh-builtin-browser: invalid carrier page handle')
    const targetId = tab.slice('page:'.length)
    const handle = this.createView(identity)
    const client = await this.ensureClient()
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
    const sessionId = attached?.sessionId
    if (typeof sessionId !== 'string') {
      throw new Error(`dsh-builtin-browser: could not attach to the existing page ${targetId}`)
    }
    this.sessions.set(sessionId, targetId)
    this.views.set(handle.id, { session: sessionId, client })
    return handle
  }

  private async adoptBlankTarget(client: CdpClient): Promise<string | undefined> {
    const listed = await client.send('Target.getTargets', {}) as {
      targetInfos?: Array<{ targetId?: string; type?: string; url?: string }>
    }
    if (!Array.isArray(listed?.targetInfos)) throw new Error('dsh-builtin-browser: the browser did not acknowledge its target inventory')
    const claimed = new Set(this.sessions.values())
    for (const entry of listed.targetInfos) {
      if (entry.type !== 'page' || typeof entry.targetId !== 'string') continue
      if (!isBlankUrl(entry.url)) continue
      if (claimed.has(entry.targetId)) continue
      return entry.targetId
    }
    return undefined
  }

  /** Create one page, refusing to go on without an id. */
  private createTarget(client: CdpClient, viewId: string): Promise<string> {
    const run = this.createTargetNow(client, viewId)
    this.creating = run.then(() => undefined, () => undefined)
    return run
  }

  private creating: Promise<void> = Promise.resolve()

  /**
   * A quiet launch makes Chromium open every new window off-screen, so a window a person or a page
   * opens (Ctrl+N, a popup) is brought on-screen, unless it is a popup of a window still parked.
   */
  private placeOpenedWindows(client: CdpClient): void {
    client.onEvent((method, params) => {
      if (method !== 'Target.targetCreated' || !this.launchParked) return
      const info = (params as { targetInfo?: { targetId?: unknown; type?: unknown; openerId?: unknown } } | undefined)?.targetInfo
      if (info?.type === 'page' && typeof info.targetId === 'string') void this.placeOpenedWindow(client, info.targetId, info.openerId)
    })
  }

  private async placeOpenedWindow(client: CdpClient, targetId: string, openerId: unknown): Promise<void> {
    try {
      for (let pending = this.creating; ; pending = this.creating) {
        await pending
        if (pending === this.creating) break
      }
      if (this.createdTargets.get(client)?.has(targetId) === true) return
      const windowOf = async (id: string) => (await client.send('Browser.getWindowForTarget', { targetId: id }) as { windowId?: unknown; bounds?: { left?: unknown; top?: unknown } } | undefined)
      const found = await windowOf(targetId)
      const left = found?.bounds?.left
      const top = found?.bounds?.top
      // Allow tolerance for DPI rounding or Windows clamping when matching the parked launch spot.
      const nearParked = typeof left === 'number' && left >= QUIET_PARK.left - QUIET_PARK_LEFT_TOLERANCE
        && (typeof top !== 'number' || Math.abs(top - QUIET_PARK.top) <= QUIET_PARK_TOP_TOLERANCE)
      if (typeof found?.windowId !== 'number' || !nearParked || this.quietParked.has(found.windowId)) return
      if (typeof openerId === 'string' && openerId !== '') {
        const opener = await windowOf(openerId).catch(() => undefined)
        if (typeof opener?.windowId === 'number' && this.quietParked.has(opener.windowId)) {
          this.quietParked.add(found.windowId)
          this.watchQuietFocus(client)
          return
        }
      }
      await this.moveOnScreen(client, found.windowId)
    } catch {
      // A window that closed or a browser that went away needs no placing.
    }
  }

  private async createTargetNow(client: CdpClient, viewId: string): Promise<string> {
    const quiet = this.isQuiet()
    const { created, parked } = quiet
      ? await this.createQuietTarget(client)
      : { created: await this.createPlainTarget(client), parked: false }
    const targetId = (created as { targetId?: string } | undefined)?.targetId
    if (typeof targetId !== 'string' || targetId === '') throw new Error('dsh-builtin-browser: the browser did not create a page')
    this.rememberTarget(client, targetId, viewId)
    if (parked) await this.parkQuietWindow(client, targetId)
    return targetId
  }

  /**
   * `background` only keeps the user's tab active inside an existing window; the first page after
   * `--no-startup-window` opens a new one. `focus: false` keeps keyboard focus where it was, and the
   * window is created off-screen in the normal state: a minimized window is hidden to the page, so
   * rAF stops and rAF-driven pages never render. A Chromium that rejects the bounds gets the page
   * without them and the window is moved off-screen right after. A tab joining an existing window
   * leaves that window where the user has it.
   */
  private async createQuietTarget(client: CdpClient): Promise<{ readonly created: unknown; readonly parked: boolean }> {
    const params = { url: 'about:blank', background: true, focus: false }
    const listed = await client.send('Target.getTargets') as { targetInfos?: Array<{ type?: string }> } | undefined
    if (listed?.targetInfos?.some(entry => entry.type === 'page') === true) {
      return { created: await client.send('Target.createTarget', params), parked: false }
    }
    try {
      return { created: await client.send('Target.createTarget', { ...params, newWindow: true, ...QUIET_PARK }), parked: true }
    } catch {
      return { created: await client.send('Target.createTarget', params), parked: true }
    }
  }

  /** A browser launched while quiet opens new windows off-screen, so a first window after quiet is turned off is placed on-screen. */
  private async createPlainTarget(client: CdpClient): Promise<unknown> {
    const params = { url: 'about:blank' }
    if (!this.launchParked) return client.send('Target.createTarget', params)
    const listed = await client.send('Target.getTargets') as { targetInfos?: Array<{ type?: string }> } | undefined
    if (listed?.targetInfos?.some(entry => entry.type === 'page') === true) return client.send('Target.createTarget', params)
    try {
      return await client.send('Target.createTarget', { ...params, newWindow: true, left: QUIET_REVEAL_INSET, top: QUIET_REVEAL_INSET })
    } catch {
      const created = await client.send('Target.createTarget', params)
      const targetId = (created as { targetId?: string } | undefined)?.targetId
      if (typeof targetId === 'string' && targetId !== '') {
        const found = await client.send('Browser.getWindowForTarget', { targetId }).catch(() => undefined) as { windowId?: unknown } | undefined
        if (typeof found?.windowId === 'number') await this.moveOnScreen(client, found.windowId).catch(() => undefined)
      }
      return created
    }
  }

  /** Windows quiet mode parked off-screen; a window quiet mode has revealed is not listed. */
  private readonly quietParked = new Set<number>()
  /** Pages whose window was just parked, until their session checks the window is clear of every display. */
  private readonly parkedTargets = new Map<string, number>()

  private async parkQuietWindow(client: CdpClient, targetId: string): Promise<void> {
    try {
      const found = await client.send('Browser.getWindowForTarget', { targetId }) as { windowId?: unknown; bounds?: { left?: unknown; top?: unknown } } | undefined
      if (typeof found?.windowId !== 'number') return
      if (found.bounds?.left !== QUIET_PARK.left || found.bounds?.top !== QUIET_PARK.top) {
        await client.send('Browser.setWindowBounds', { windowId: found.windowId, bounds: { ...QUIET_PARK } })
      }
      this.quietParked.add(found.windowId)
      this.parkedTargets.set(targetId, found.windowId)
      this.watchQuietFocus(client)
    } catch {
      // Without its id the window cannot be moved or revealed later, so it stays where Chromium put it.
    }
  }

  /**
   * Move a parked window past any display it still overlaps. The page's `screen` is the display
   * the window overlaps most (or the nearest one), so stepping past it until no display claims the
   * window clears the union of all displays, wherever the provisional position landed.
   */
  private async clearDisplays(client: CdpClient, sessionId: string, targetId: string): Promise<void> {
    const windowId = this.parkedTargets.get(targetId)
    if (windowId === undefined) return
    this.parkedTargets.delete(targetId)
    try {
      for (let step = 0; step < 8; step++) {
        const g = await windowGeometry(client, sessionId)
        if (g === undefined) return
        const overlaps = g.x < g.sl + g.sw && g.x + g.ow > g.sl && g.y < g.st + g.sh && g.y + g.oh > g.st
        if (!overlaps) return
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: g.sl + g.sw + QUIET_PARK_GAP, top: g.st } })
      }
    } catch {
      // A page that cannot report its geometry keeps the provisional position.
    }
  }

  private foreground: ForegroundWatch | undefined
  private foregroundStarting = false
  private foregroundFailed = false
  /** A takeover page hidden behind another tab, brought to the front once the person activates its revealed window. */
  private quietFront: QuietFront | undefined
  /** Windows quiet mode parked and has since put on-screen. */
  private readonly quietRevealed = new Set<number>()
  /** The real watcher exists on Windows only; tests replace it. */
  watchForeground: ForegroundWatcher = watchForeground

  private quietWatched(): boolean { return this.quietParked.size > 0 || this.quietFront !== undefined }

  /**
   * A CDP click focuses the page, not the window, but Chrome activates its window for a tab the click
   * opens; the watcher gives that foreground back. Our Chrome in the foreground off every display
   * otherwise means a person activated the parked window from the taskbar or Alt-Tab. Asked of the OS,
   * it works with no view attached (after a reset).
   */
  private watchQuietFocus(client: CdpClient): void {
    if (this.foreground !== undefined || this.foregroundStarting) return
    this.foregroundStarting = true
    void (async () => {
      try {
        const info = await client.send('SystemInfo.getProcessInfo', {}, undefined, 1000) as { processInfo?: Array<{ type?: string; id?: number }> } | undefined
        const pid = info?.processInfo?.find(entry => entry.type === 'browser')?.id
        if (typeof pid !== 'number' || this.disposed || !this.quietWatched()) return this.sendQuietFront()
        const watch = this.watchForeground(event => { if (event.pid === pid) void this.onForeground(client, event) }, reason => {
          if (!this.foregroundFailed) {
            this.foregroundFailed = true
            console.warn(`[dsh-browser] quiet window: cannot watch the foreground window (${reason}); the panel and takeovers still bring it on-screen`)
          }
          if (this.foreground === watch) this.foreground = undefined
          this.sendQuietFront()
        }, pid)
        this.foreground = watch
        if (watch === undefined) this.sendQuietFront()
      } catch {
        // Without the browser's process id, the panel and a takeover still reveal the window.
        this.sendQuietFront()
      } finally {
        this.foregroundStarting = false
      }
    })()
  }

  private async onForeground(client: CdpClient, event: ForegroundEvent): Promise<void> {
    if (event.yielded === true) return
    if (event.offscreen) {
      for (const windowId of [...this.quietParked]) {
        this.quietParked.delete(windowId)
        this.quietRevealed.add(windowId)
        await this.moveOnScreen(client, windowId, await this.sessionInWindow(client, windowId)).catch(() => undefined)
      }
    } else if (this.quietFront !== undefined && await this.isFrontWindow(this.quietFront, event)) {
      const front = this.quietFront
      this.quietFront = undefined
      await front.client.send('Page.bringToFront', {}, front.session).catch(() => undefined)
    }
    if (!this.quietWatched()) this.stopForeground()
  }

  /** A page attached in the window, to measure the display it lands on. */
  private async sessionInWindow(client: CdpClient, windowId: number): Promise<string | undefined> {
    for (const view of [...this.views.values()]) {
      const targetId = this.sessions.get(view.session)
      if (targetId === undefined || view.client !== client) continue
      const found = await client.send('Browser.getWindowForTarget', { targetId }).catch(() => undefined) as { windowId?: unknown } | undefined
      if (found?.windowId === windowId) return view.session
    }
    return undefined
  }

  /** The watcher names the process, not the window: only the takeover's own window, where it now is, counts. */
  private async isFrontWindow(front: QuietFront, event: ForegroundEvent): Promise<boolean> {
    if (event.left === undefined || event.top === undefined) return false
    try {
      const found = await front.client.send('Browser.getWindowForTarget', { targetId: front.targetId }) as { bounds?: { left?: unknown; top?: unknown } } | undefined
      const left = found?.bounds?.left
      const top = found?.bounds?.top
      return typeof left === 'number' && typeof top === 'number' &&
        Math.abs(left - event.left) <= QUIET_FRONT_SLACK && Math.abs(top - event.top) <= QUIET_FRONT_SLACK
    } catch {
      return false
    }
  }

  /** Nothing can tell when the person activates the window, so a waiting hidden page comes to the front now. */
  private sendQuietFront(): void {
    const front = this.quietFront
    this.quietFront = undefined
    if (front !== undefined) void front.client.send('Page.bringToFront', {}, front.session).catch(() => undefined)
  }

  private stopForeground(): void {
    this.foreground?.stop()
    this.foreground = undefined
  }

  /** Move a window onto the primary display (it holds the origin), sized to fit when its page can say so, without activating it. */
  private async moveOnScreen(client: CdpClient, windowId: number, session?: string): Promise<WindowGeometry | undefined> {
    await client.send('Browser.setWindowBounds', { windowId, bounds: { left: QUIET_REVEAL_INSET, top: QUIET_REVEAL_INSET } })
    const g = session === undefined ? undefined : await windowGeometry(client, session)
    if (g !== undefined && (g.ow > g.sw - QUIET_REVEAL_INSET || g.oh > g.sh - QUIET_REVEAL_INSET)) {
      await client.send('Browser.setWindowBounds', { windowId, bounds: {
        width: Math.min(g.ow, g.sw - QUIET_REVEAL_INSET), height: Math.min(g.oh, g.sh - QUIET_REVEAL_INSET) } })
    }
    return g
  }

  /**
   * Move a window quiet mode parked onto the primary display. Quiet tabs open in the background, so
   * the window may be showing an earlier tab: a person's own selection brings the page to the front.
   * `Page.bringToFront` activates the window, so for a takeover of a hidden page it waits until the
   * person activates the revealed window (where nothing watches the foreground, it is sent at once).
   * From then on the window is the person's and quiet mode never moves it.
   * @returns whether a parked window was moved.
   */
  async revealQuietWindow(handle: ElectronViewHandle, options?: QuietRevealOptions): Promise<boolean> {
    const view = this.views.get(handle.id)
    const targetId = view === undefined ? undefined : this.sessions.get(view.session)
    if ((this.quietParked.size === 0 && this.quietRevealed.size === 0) || view === undefined || targetId === undefined) return false
    try {
      // Asked of the browser by target id: the view's own command path would replace a closed page with a blank one.
      const found = await view.client.send('Browser.getWindowForTarget', { targetId }) as { windowId?: unknown } | undefined
      if (typeof found?.windowId !== 'number') return false
      const parked = this.quietParked.delete(found.windowId)
      if (!parked && !this.quietRevealed.has(found.windowId)) return false
      // A window already revealed (a skipped takeover, retried) stays where the person has it; only its tab is selected.
      const g = parked ? await this.moveOnScreen(view.client, found.windowId, view.session) : await windowGeometry(view.client, view.session)
      this.quietRevealed.add(found.windowId)
      if (options?.select === true) await view.client.send('Page.bringToFront', {}, view.session)
      else if (g?.hidden === true) {
        const front = { client: view.client, session: view.session, targetId }
        this.quietFront = front
        options?.until?.addEventListener('abort', () => {
          if (this.quietFront !== front) return
          this.quietFront = undefined
          if (!this.quietWatched()) this.stopForeground()
        }, { once: true })
        this.watchQuietFocus(view.client)
      }
      if (!this.quietWatched()) this.stopForeground()
      return parked
    } catch {
      // The page went away; the command that selected it reports that itself.
      return false
    }
  }

  private rememberTarget(client: CdpClient, targetId: string, viewId: string): void {
    let targets = this.createdTargets.get(client)
    if (!targets) { targets = new Map(); this.createdTargets.set(client, targets) }
    targets.set(targetId, viewId as BrowserTabWireId)
  }

  /** Views whose session is being created right now, so a second caller waits for the first. */
  private readonly sessionBuilding = new Map<string, Promise<string>>()

  /** Serialises page selection/creation and attachment for each browser connection. */
  private readonly targetBuilds = new WeakMap<CdpClient, Promise<void>>()

  /** sessionId -> targetId, so a destroyed view can close the right page. */
  private readonly sessions = new Map<string, string>()
}

/**
 * Probe for a browser the human already has open with a debugging port.
 *
 * Chromium exposes CDP only when it was STARTED with --remote-debugging-port, so an already-running Edge
 * cannot be attached unless it was launched that way. Attaching is therefore opt-in: this probe answers
 * "is there something to attach to right now", and the caller decides whether to use it.
 * @param port - the debugging port to try (default 9222).
 * @param timeoutMs - how long to wait for the endpoint.
 * @returns the browser banner when an endpoint answers, undefined otherwise.
 */
export async function probeAttach(port: number = CDP_DEFAULT_ATTACH_PORT, timeoutMs: number = CDP_ATTACH_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(cdpVersionUrl(port), { signal: controller.signal })
    if (!response.ok) return undefined
    const body = await response.json() as { Browser?: unknown }
    return typeof body.Browser === 'string' ? body.Browser : 'unknown'
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
