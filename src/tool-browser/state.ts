/**
 * Per-apply browser tool state: task sessions, the allow-list restriction, and surface rules.
 * @module dsh-browser/tool-browser/state
 */

import type { Context } from '@deepseek-ai/cordis'
import { BrowserTakeovers } from './takeover.ts'
import { readFileSync } from 'node:fs'
import type { defineTool } from '@deepseek-ai/dsh-tools'
import { SettingsStore, settingsPath } from '../browser-electron/settings-store.ts'
import { assertCapability, CDP_CARRIER_CAPABILITIES, WEB_PANEL_CAPABILITIES, type BrowserSessionId, type CarrierCapabilities } from '../browser/types.ts'
import { MAX_FILL_FIELDS, TOOL_WAIT_MIN_MS, TOOL_WAIT_RESERVE_MS } from '../../assets/browser-policy.mjs'
import type { Config } from './index.ts'

/**
 * Register a cleanup that runs once when the process exits.
 *
 * A single hook per process, holding a list of callbacks, rather than one listener per
 * session: sessions come and go, listeners do not, and Node warns when a listener count
 * passes ten.
 */
export const exitCleanups = new Set<() => void>()
let exitHookInstalled = false
export function registerExitCleanup(cleanup: () => void): void {
  exitCleanups.add(cleanup)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const run of exitCleanups) {
      try { run() } catch { /* exiting; nothing useful to do */ }
    }
  })
}

/**
 * Which surface an open should use.
 *
 * "panel"  - place the page in the DSH sidebar and open nothing else (the normal Web behaviour).
 * "builtin"- drive the plugin's own browser; needed when the thing under test IS DSH.
 * @returns the configured surface, defaulting to "panel".
 */
export function readSurface(): 'panel' | 'builtin' {
  // A host that already resolved the surface declares it; otherwise the plugin's own settings file under
  // the live DSH_HOME decides. No machine-specific path is consulted.
  const declared = (globalThis as unknown as Record<string, unknown>).__dshBrowserSurface
  if (declared === 'panel' || declared === 'builtin') return declared
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { browser?: { surface?: unknown } }
    const surface = parsed.browser?.surface
    if (surface === 'builtin' || surface === 'panel') return surface
  } catch { /* no settings yet */ }
  return 'panel'
}

/**
 * Keep the built-in browser for DSH itself.
 *
 * "builtin" exists to debug DSH: a client bundle, the settings panel, the sidebar UI. Using it for an
 * ordinary site opens a window the reader did not ask for — measured as "why did you open the built-in
 * browser again". A non-loopback target therefore degrades to "panel" silently; the caller's intent does
 * not override the rule.
 * @param surface - the requested surface.
 * @param url - the page being opened.
 * @returns the surface that will actually be used.
 */
export function enforceSurface(surface: 'panel' | 'builtin', _url: string): 'panel' | 'builtin' {
  // The caller decides the surface. An earlier version degraded "builtin" to "panel" for anything but a
  // loopback URL, which also blocked the agent from driving the human's OWN browser — the opposite of what
  // the setting is for. Which window appears is decided by the carrier (bundled Electron vs. the human's
  // Edge), not by the URL. Keeping ordinary tests on the sidebar is a working rule, not a code constraint.
  return surface
}

/**
 * Refuse a request that cannot work BEFORE anything is opened.
 *
 * The sidebar renders pages through a same-origin proxy, so asking it to load this machine answers with a
 * network-level failure that reads like a bug in the page. Reporting that afterwards is useless — the call
 * already happened. The rule is therefore enforced up front: a loopback target on the panel surface is
 * refused, and the message names the surface that does work.
 * @param surface - the surface this call would use.
 * @param url - the page being opened.
 */
export function assertSurfaceCanHost(surface: 'panel' | 'builtin', url: string): void {
  if (surface !== 'panel') return
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^127\./u.test(host)
  if (!local) return
  throw new Error('dsh-builtin-browser: the sidebar cannot host this machine (' + host
    + '). It proxies pages through itself, so loading DSH there is the proxy fetching its own server. '
    + '调试 DSH 请用 surface: "builtin"（内置浏览器），普通网页才走侧栏。')
}

/** Per-apply (per-context) tool state: sessions, in-flight opens, restriction. */
export interface ToolBrowserState {
  /** Per-task browser sessions, keyed by the calling DSH session id. */
  readonly sessionsByTask: Map<string, BrowserSessionId>
  /** In-flight first-open per task key, so concurrent first calls share one session. */
  readonly pendingOpens: Map<string, Promise<BrowserSessionId>>
  /**
   * Action restriction per task, plus one from the plugin's own configuration.
   *
   * Two different things share this policy. A restriction from `cordis.patch.yml` is an
   * operator decision about the whole plugin, so it applies to everyone and lives in
   * `configRestrictedTo`. One set by `dsh_browser_restrict` is a decision by one task about
   * its own work, so it is keyed by task — a single shared value let one task lock the
   * browser tools of every other task, which is not what any caller asks for. Sessions
   * beside it were already keyed this way; this was not.
   */
  configRestrictedTo: readonly string[] | undefined
  restrictedByTask: Map<string, readonly string[]>
  /** Active panel opens, including Web iframes that cannot be driven over CDP. */
  panelUrlByTask: Map<string, string>
  pendingPanelOpens: Map<string, Promise<void>>
}

export function createState(): ToolBrowserState {
  return {
    sessionsByTask: new Map(), pendingOpens: new Map(), configRestrictedTo: undefined,
    restrictedByTask: new Map(), panelUrlByTask: new Map(), pendingPanelOpens: new Map(),
  }
}

/** Every live state, for the test hook (introspection only, never shared). */
export const liveStates = new Set<ToolBrowserState>()

/**
 * Tools that only observe, plus the ones that undo a restriction.
 *
 * Never subject to an allow-list: restricting what the agent may *do* must not also
 * blind it or trap it, and the tool descriptions promise as much. dsh_browser_restrict
 * is in here so a task that restricted everything can still lift it.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Tools that only observe.
  'dsh_browser_snapshot', 'dsh_browser_a11y', 'dsh_browser_content', 'dsh_browser_scrape',
  'dsh_browser_screenshot', 'dsh_browser_get_value', 'dsh_browser_wait', 'dsh_browser_challenge',
  'dsh_browser_list_tabs', 'dsh_browser_session', 'dsh_browser_history', 'dsh_browser_visited',
  // Observation added in 0.5.7: console lines, network responses, an assertion, a self-check and the
  // help index. All five only read (the probe's buffers belong to the page, not to the task), so an
  // allow-list must not blind a task that restricted itself.
  'dsh_browser_console', 'dsh_browser_network', 'dsh_browser_wait_for_response',
  'dsh_browser_assert', 'dsh_browser_doctor', 'dsh_browser_help',
  // Reading the page's own digest and searching its text: observation like the rest.
  'dsh_browser_find', 'dsh_browser_state',
  // Where the page keeps its data: shapes of what the page already holds, never a request.
  'dsh_browser_data_sources',
  // References read the page the human already has open and write only this plugin's own store;
  // restricting an agent's actions must not stop it from recording what it was told to read.
  'dsh_browser_reference_capture', 'dsh_browser_reference_reveal', 'dsh_browser_reference_list',
  // dsh_browser_auth reads cookies out of the browser: an observation, and one the
  // credentials switch gates on its own (see credentials.allowRead in the settings).
  // dsh_browser_auth is deliberately NOT here. It reads cookies on "flush" but WRITES them on
  // "restore", to arbitrary domains, which is an action like any other — exempting the tool
  // would let a task that restricted its own actions rewrite the shared browser's logins.
  //
  // Getting out of a bad state, or lifting the restriction itself. Without these a task
  // that restricted everything could neither recover nor be released.
  'dsh_browser_restrict', 'dsh_browser_reset_session', 'dsh_browser_reset',
])

/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param state - the calling context's tool state.
 * @param toolName - the browser tool about to run.
 */
export function assertAllowed(state: ToolBrowserState, toolName: string, task: string): void {
  // dsh_browser_restrict must stay usable, or a task that restricted everything
  // could never lift it again.
  // An allow-list is a statement about ACTIONS, so it must not take away the ability to
  // look, or to get out of a bad state. The tool description and both READMEs promise
  // that read-only tools are never blocked; before this they were, because only
  // dsh_browser_restrict itself was exempt — a narrow list then locked dsh_browser_history,
  // dsh_browser_reset_session and dsh_browser_auth away with no way back.
  if (READ_ONLY_TOOLS.has(toolName) || toolName === 'dsh_browser_restrict') return
  const config = state.configRestrictedTo
  if (config !== undefined && !config.includes(toolName)) {
    throw new Error(`browser action "${toolName}" is restricted by the plugin configuration (allow-list: ${config.join(', ')})`)
  }
  const allowed = state.restrictedByTask.get(task)
  if (allowed === undefined || allowed.includes(toolName)) return
  throw new Error(`browser action "${toolName}" is restricted (allow-list: ${allowed.join(', ')})`)
}

/** The agent view a tool execution carries (id + agent-scoped context). */
export interface ExecAgent {
  readonly id?: string
  /** Agent-scoped Cordis context; its effects unwind on agent disposal. */
  readonly ctx?: Context
}

/** Extract the agent from a tool-execution context, when one exists. */
export function agentOf(exec: unknown): ExecAgent | undefined {
  return (exec as { agent?: ExecAgent } | undefined)?.agent
}

/**
 * The task key for a tool call: the calling DSH session id, or the shared
 * default key when the call carries no agent context (CLI probes, tests).
 * @param exec - the tool-execution context; only its optional agent id is read.
 */
export function taskKey(exec: { agent?: { id?: string } } | undefined): string {
  return exec?.agent?.id ?? 'default'
}

/** Whether this task's page was placed in the DSH sidebar panel rather than a plugin-owned window. */
export function panelBound(state: ToolBrowserState, key: string): boolean {
  return state.panelUrlByTask.has(key)
}

/**
 * What the task's current carrier can do. A panel placement without a live CDP session is the Web
 * iframe panel: it can only be navigated. Everything else is a CDP-backed page.
 */
export function carrierCapabilities(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string): CarrierCapabilities {
  const session = state.sessionsByTask.get(key)
  return panelBound(state, key) && (session === undefined || !browser.exists(session)) ? WEB_PANEL_CAPABILITIES : CDP_CARRIER_CAPABILITIES
}

export function rememberSession(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string, agent: ExecAgent | undefined, session: BrowserSessionId | undefined, panelUrl?: string): void {
  const previous = state.sessionsByTask.get(key)
  const previousPanelUrl = state.panelUrlByTask.get(key)
  if (session === undefined) state.sessionsByTask.delete(key)
  else state.sessionsByTask.set(key, session)
  if (panelUrl === undefined) state.panelUrlByTask.delete(key)
  else state.panelUrlByTask.set(key, panelUrl)
  if (previous === session && (previousPanelUrl !== undefined) === (panelUrl !== undefined)) return
  const cleanup = (): void => {
    if (state.sessionsByTask.get(key) !== session || state.panelUrlByTask.has(key) !== (panelUrl !== undefined)) return
    state.sessionsByTask.delete(key)
    state.panelUrlByTask.delete(key)
    if (session !== undefined) void browser.close(session).catch(() => {})
  }
  try {
    if (agent?.ctx !== undefined) agent.ctx.effect(() => cleanup)
    else if (key === 'default' && session !== undefined) registerExitCleanup(() => browser.close(session).catch(() => {}))
  } catch (error) {
    cleanup()
    if (previous !== undefined) state.sessionsByTask.set(key, previous)
    if (previousPanelUrl !== undefined) state.panelUrlByTask.set(key, previousPanelUrl)
    throw error
  }
  if (previous !== undefined && previous !== session) void browser.close(previous).catch(() => {})
}

/**
 * Resolve the calling task's browser session, opening one on first use.
 * Concurrent first calls for the same key share a single open. When the call
 * carries an agent, the session's lifetime is tied to the agent's scoped
 * context: it closes automatically when the agent (DSH session) is disposed,
 * so sessions and their windows never leak after a task ends.
 * @param browser - the seam service.
 * @param state - the calling context's tool state.
 * @param key - the task key (see {@link taskKey}).
 * @param agent - the calling agent, when any (its ctx owns the session).
 * @returns the task's session id.
 */
export async function ensureSession(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string, agent?: ExecAgent, create = false): Promise<BrowserSessionId> {
  await state.pendingPanelOpens.get(key)
  const existing = state.sessionsByTask.get(key)
  if (existing !== undefined) {
    // The human closing a browser window ends that session, so a cached id can
    // be stale: never hand a dead session back to a tool call.
    if (browser.exists(existing)) return existing
    state.sessionsByTask.delete(key)
  }
  const pending = state.pendingOpens.get(key)
  if (pending !== undefined) return pending
  assertCapability(carrierCapabilities(browser, state, key), 'cdp',
    'dsh-builtin-browser: the panel surface has no live CDP session for this operation. '
    + 'Use the CDP-backed DSH desktop sidebar with a connected desktop bridge and call dsh_browser_open again. '
    + 'The Web iframe panel cannot provide live snapshots, a11y, content, scrape, screenshots, interactions, '
    + 'uploads, downloads, or reference capture. Reading tools never start a separate browser.')
  // Starting a browser is `dsh_browser_open`'s job and nobody else's. A read tool asking "what is on
  // screen" used to start one — which, with the human's own Edge already running, handed the command over
  // and opened yet another window, reported as "one look, two Edge windows". A reader with nothing open
  // reports that instead of launching anything.
  if (!create) {
    throw new Error('dsh-builtin-browser: nothing is open in this task yet — call dsh_browser_open first. '
      + 'Reading tools never start a browser.')
  }
  // The task key rides along as the session label so the window title shows
  // which task's page is currently visible to the human.
  const opening = browser.open(key).then(
    session => {
      state.pendingOpens.delete(key)
      rememberSession(browser, state, key, agent, session)
      return session
    },
    error => { state.pendingOpens.delete(key); throw error },
  )
  state.pendingOpens.set(key, opening)
  return opening
}

/** What every tool module closes over: the apply's context, settings and per-apply state. */
export interface ToolScope {
  readonly ctx: Context
  readonly config: Config
  readonly state: ToolBrowserState
  readonly takeovers: BrowserTakeovers
  readonly settingsStore: SettingsStore
  readonly timeoutMs: number
  readonly maxWaitMs: number
  readonly maxFillFields: number
  readonly surface: NonNullable<Config['surface']>
}

/** One tool definition, as `defineTool` returns it. */
export type ToolDefinition = ReturnType<typeof defineTool>

/**
 * Longest wait `dsh_browser_wait` may poll for, leaving room for the tool call itself to
 * finish and report.
 *
 * `dsh_browser_wait` promises a VERDICT — `{ready:false, reason}` — and the enclosing tool
 * call aborts at `timeoutMs`. A caller-supplied budget longer than that aborted the call
 * instead, so the documented verdict never arrived. Clamping to just inside the budget is
 * what keeps the promise: the polling stops, the reason is returned.
 */
export function maxWaitFor(timeoutMs: number): number {
  return Math.max(TOOL_WAIT_MIN_MS, timeoutMs - TOOL_WAIT_RESERVE_MS)
}

/**
 * Most fields `dsh_browser_fill` accepts in one batch.
 *
 * The batch runs as ONE page evaluation, so hundreds of fields do not produce hundreds of
 * per-field verdicts — they produce a single evaluate that exceeds the tool budget and
 * throws, which is the opposite of the documented "per-field failures are reported instead
 * of throwing". Real forms are far smaller than this; anything larger should be split.
 */
export { MAX_FILL_FIELDS }

/** Every tool, in the order the entry registers it (and the code tool's catalog lists it). */
export const REGISTRATION_ORDER: readonly string[] = [
  'dsh_browser_request_takeover', 'dsh_browser_shortcuts', 'dsh_browser_open', 'dsh_browser_snapshot',
  'dsh_browser_a11y', 'dsh_browser_challenge', 'dsh_browser_wait', 'dsh_browser_execute',
  'dsh_browser_content', 'dsh_browser_scrape', 'dsh_browser_click', 'dsh_browser_click_sequence',
  'dsh_browser_type', 'dsh_browser_scroll', 'dsh_browser_back', 'dsh_browser_forward', 'dsh_browser_refresh',
  'dsh_browser_key', 'dsh_browser_fill', 'dsh_browser_set_value', 'dsh_browser_check', 'dsh_browser_select',
  'dsh_browser_clear', 'dsh_browser_get_value', 'dsh_browser_screenshot', 'dsh_browser_list_tabs',
  'dsh_browser_switch_tab', 'dsh_browser_close_tab', 'dsh_browser_reset', 'dsh_browser_history',
  'dsh_browser_visited', 'dsh_browser_replay', 'dsh_browser_download', 'dsh_browser_session',
  'dsh_browser_reset_session', 'dsh_browser_restrict', 'dsh_browser_auth', 'dsh_browser_console',
  'dsh_browser_network', 'dsh_browser_dialog', 'dsh_browser_wait_for_response', 'dsh_browser_assert',
  'dsh_browser_drag', 'dsh_browser_doctor', 'dsh_browser_help', 'dsh_browser_do', 'dsh_browser_upload',
  'dsh_browser_hover', 'dsh_browser_find', 'dsh_browser_state', 'dsh_browser_reference_capture',
  'dsh_browser_reference_reveal', 'dsh_browser_reference_list', 'dsh_browser_data_sources', 'dsh_browser_fetch_json',
]

/** Test hook: inspect and reset session mappings across every live plugin apply. */
export const internals = {
  /** A copy of every live apply's per-task session map (task key -> provider session id). */
  get sessions(): ReadonlyMap<string, BrowserSessionId> {
    const merged = new Map<string, BrowserSessionId>()
    for (const state of liveStates) {
      for (const [key, session] of state.sessionsByTask) merged.set(key, session)
    }
    return merged
  },
  /** Drop one task's mapping (across live applies) without closing the provider session. */
  clearSession(key = 'default'): void {
    for (const state of liveStates) state.sessionsByTask.delete(key)
  },
}
