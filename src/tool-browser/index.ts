/**
 * Model-facing browser tools over `ctx.browser`: `dsh_browser_open`,
 * `dsh_browser_snapshot`, `dsh_browser_execute`, `dsh_browser_content`,
 * `dsh_browser_screenshot`, and tab management (`dsh_browser_list_tabs`,
 * `dsh_browser_switch_tab`, `dsh_browser_close_tab`, `dsh_browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: each
 * calling task (a DSH session) gets its own browser session — the first
 * `dsh_browser_open` (or any tool when no session exists) opens it, and later
 * tools in the same task reuse it. Concurrent tasks therefore never fight
 * over tabs, history, or navigation state.
 * @module dsh-browser/tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { SCREENSHOT_MAX_WIDTH, SCREENSHOT_MAX_HEIGHT, screenshotDimension, screenshotBytes, screenshotVisionEnabled, saveScreenshotImage } from './screenshot-image.ts'
import { BrowserTakeovers, installTakeovers } from './takeover.ts'
import { TAKEOVER_TOOL, type TakeoverDecision, type TakeoverSummary } from '../takeover-protocol.ts'
import { clearLastOpen, getLastOpen, setLastOpen } from '../browser-electron/open-slot.ts'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { pageOperationScript } from './page-probe.ts'
import { CODE_PROMPT, CODE_TOOL, createCodeTool, type CatalogTool } from './code-tool.ts'
import { SettingsStore, settingsPath } from '../browser-electron/settings-store.ts'
import { createShortcutStore, type ShortcutSettings } from '../browser-electron/startpage-shortcuts.ts'
import { createReferenceService, summarizeReference, type BrowserReferenceService } from '../browser-reference/service.ts'
import type { BrowserReferenceCarrier } from '../browser-reference/types.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BrowserSessionId, BrowserPageOperationRequest, BrowserProbeMethod } from '../browser/types.ts'
import { browserSessionHandle, resolveSessionHandle, resolveTabHandle, scopedTabs, sessionWireId, tabWireId } from '../browser/handles.ts'
import {
  ELEMENT_ITEM_SCHEMA,
  NODE_ITEM_SCHEMA,
  projectElement,
  projectNode,
} from './element-fields.ts'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Register a cleanup that runs once when the process exits.
 *
 * A single hook per process, holding a list of callbacks, rather than one listener per
 * session: sessions come and go, listeners do not, and Node warns when a listener count
 * passes ten.
 */
const exitCleanups = new Set<() => void>()
let exitHookInstalled = false
function registerExitCleanup(cleanup: () => void): void {
  exitCleanups.add(cleanup)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const run of exitCleanups) {
      try { run() } catch { /* exiting; nothing useful to do */ }
    }
  })
}


/** Plugin name used by loader diagnostics. */

/**
 * Which surface an open should use.
 *
 * "panel"  - place the page in the DSH sidebar and open nothing else (the normal Web behaviour).
 * "builtin"- drive the plugin's own browser; needed when the thing under test IS DSH.
 * @returns the configured surface, defaulting to "panel".
 */
function readSurface(): 'panel' | 'builtin' {
  // Try every plausible location and take the first file that actually carries the key. The plugin's
  // own settingsPath() is preferred, but a module instance can hold a stale home while another module in
  // the same process holds the live one — which is exactly why channel read fine and surface did not.
  const declared = (globalThis as unknown as Record<string, unknown>).__dshBrowserSurface
  if (declared === 'panel' || declared === 'builtin') return declared
  const candidates: string[] = []
  try { candidates.push(settingsPath()) } catch { /* no module home */ }
  candidates.push('D:/dsh-home/dsh-builtin-browser-host/settings.json')
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { browser?: { surface?: unknown } }
      const surface = parsed.browser?.surface
      if (surface === 'builtin' || surface === 'panel') return surface
    } catch { /* next candidate */ }
  }
  return 'panel'
}



// One line at registration: tool handlers are registered once per host start, and a recomposition does
// not re-register them. Printing the resolved surface here is the only reliable way to tell WHICH build a
// live host is actually running, instead of inferring it from behaviour.
try { console.log('[tool-browser] registered, surface=' + readSurface()) } catch { /* logging only */ }


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
function enforceSurface(surface: 'panel' | 'builtin', _url: string): 'panel' | 'builtin' {
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
function assertSurfaceCanHost(surface: 'panel' | 'builtin', url: string): void {
  if (surface !== 'panel') return
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^127\./u.test(host)
  if (!local) return
  throw new Error('dsh-builtin-browser: the sidebar cannot host this machine (' + host
    + '). It proxies pages through itself, so loading DSH there is the proxy fetching its own server. '
    + '调试 DSH 请用 surface: "builtin"（内置浏览器），普通网页才走侧栏。')
}

export const name = 'tool-browser'
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export const inject = ['tools', 'browser', 'systemPrompt']

/** Plugin config: tool timeouts and session defaults. */
export interface Config {
  /** Cooperative tool-call budget in ms. Default 60000. */
  readonly timeoutMs?: number
  /** Whether to offer tab-management tools. Default true. */
  readonly tabTools?: boolean
  /** Optional initial allow-list of browser tool names; other tools are refused. */
  readonly allowedActions?: readonly string[]
  /**
   * What the model sees. "code" (default): one dsh_browser_code tool whose script calls every
   * browser action as a helper, plus dsh_browser_request_takeover. "tools": every action as its
   * own tool.
   */
  readonly surface?: 'core' | 'code' | 'tools'
}

/** Per-apply (per-context) tool state: sessions, in-flight opens, restriction. */
interface ToolBrowserState {
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

function createState(): ToolBrowserState {
  return {
    sessionsByTask: new Map(), pendingOpens: new Map(), configRestrictedTo: undefined,
    restrictedByTask: new Map(), panelUrlByTask: new Map(), pendingPanelOpens: new Map(),
  }
}

/** Every live state, for the test hook (introspection only, never shared). */
const liveStates = new Set<ToolBrowserState>()

/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param state - the calling context's tool state.
 * @param toolName - the browser tool about to run.
 */
/**
 * Tools that only observe, plus the ones that undo a restriction.
 *
 * Never subject to an allow-list: restricting what the agent may *do* must not also
 * blind it or trap it, and the tool descriptions promise as much. dsh_browser_restrict
 * is in here so a task that restricted everything can still lift it.
 */
/** Tool loaded on demand: registers a group of browser tools for the rest of the run. */
export const LOAD_TOOL = 'dsh_browser_load_tools'

/** Tools the model sees from the start on the default `core` surface. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'dsh_browser_open', 'dsh_browser_snapshot', 'dsh_browser_a11y', 'dsh_browser_click', 'dsh_browser_type',
  'dsh_browser_key', 'dsh_browser_scroll', 'dsh_browser_select', 'dsh_browser_fill', 'dsh_browser_wait',
  'dsh_browser_content', 'dsh_browser_find', 'dsh_browser_scrape', 'dsh_browser_screenshot',
  'dsh_browser_execute', 'dsh_browser_do', 'dsh_browser_state', 'dsh_browser_challenge',
  'dsh_browser_list_tabs', 'dsh_browser_switch_tab', 'dsh_browser_close_tab', 'dsh_browser_back',
  'dsh_browser_reference_capture', 'dsh_browser_reference_reveal', 'dsh_browser_reference_list',
  'dsh_browser_request_takeover', 'dsh_browser_help',
])

/**
 * The rest of the catalog, loaded by group with dsh_browser_load_tools. A loaded tool is never
 * unregistered, so the tool list only grows and the request prefix stays cacheable. Any tool not
 * named here or in CORE_TOOLS belongs to `more`.
 */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  forms: ['dsh_browser_check', 'dsh_browser_clear', 'dsh_browser_set_value', 'dsh_browser_get_value', 'dsh_browser_upload', 'dsh_browser_drag', 'dsh_browser_hover', 'dsh_browser_dialog', 'dsh_browser_click_sequence'],
  navigation: ['dsh_browser_forward', 'dsh_browser_refresh', 'dsh_browser_history', 'dsh_browser_replay', 'dsh_browser_visited', 'dsh_browser_download'],
  debug: ['dsh_browser_console', 'dsh_browser_network', 'dsh_browser_wait_for_response', 'dsh_browser_assert', 'dsh_browser_doctor'],
  session: ['dsh_browser_session', 'dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_restrict', 'dsh_browser_auth', 'dsh_browser_shortcuts'],
  more: [],
}

/** Guide for the `core` surface. Static, so the prompt prefix caches. */
const CORE_PROMPT = 'Operate the built-in browser with the dsh_browser_* tools. Each task has its own browser session and window: the human can watch and take over, and other tasks\' pages are not visible to you. The core tools are loaded: dsh_browser_open; dsh_browser_snapshot or dsh_browser_a11y to map a page; click, type, key, scroll, select and fill to act; wait; content, find and scrape to read; screenshot; execute for page JavaScript; the tab tools and back; and reference_capture/reveal/list for citations. Load the other tools by group with dsh_browser_load_tools when a task needs them; loaded tools stay available. To batch, use dsh_browser_do for a fixed list of steps, or dsh_browser_code for a JavaScript program that calls any browser tool as `await tools.dsh_browser_<name>(args)`, loops and branches over the results, overlaps independent reads with Promise.all and prints only what you need. Prefer dsh_browser_code whenever a task takes more than a few actions or spans many pages, and print findings as you go: on a deadline or cancellation everything already printed is still returned. When run_code is available, call the same tools from run_code instead. A blocked page (403, access denied, bot wall) is not the end of the task. Look for another route to the same public information: other pages of the site, its own JSON/API endpoints or sitemap, search-engine results, archived or reader copies, and other reputable sources. Keep each value tied to the source it came from. Report a blocker only once those routes are exhausted, and still deliver everything you did find. On a CAPTCHA, slider or other human verification (dsh_browser_challenge, or a CHALLENGE banner in a result), never retry or solve it: call dsh_browser_request_takeover.'

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
function assertAllowed(state: ToolBrowserState, toolName: string, task: string): void {
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
interface ExecAgent {
  readonly id?: string
  /** Agent-scoped Cordis context; its effects unwind on agent disposal. */
  readonly ctx?: Context
}

/** Extract the agent from a tool-execution context, when one exists. */
function agentOf(exec: unknown): ExecAgent | undefined {
  return (exec as { agent?: ExecAgent } | undefined)?.agent
}

/**
 * Refuse the bare DSH web root, which answers 401 and looks like a real page.
 *
 * The address comes from `DSH_WEB_URL`, which the harness exports to its children — NOT from a
 * hardcoded port. This machine's GUI has run on 3080 and on 19387, so a number would stop matching
 * exactly when the guard is needed, and the trap is not a port anyway: it is the SHAPE. A loopback
 * address at its root with no token renders as an unauthenticated 401 page, which an agent reads
 * as the site it meant to open.
 * @param rawUrl - the address a caller asked to open.
 */
function assertNotBareDshWebUrl(rawUrl: string): void {
  const advertised = process.env.DSH_WEB_URL
  if (typeof advertised !== 'string' || advertised === '') return
  let target: URL
  let dsh: URL
  try {
    target = new URL(rawUrl)
    dsh = new URL(advertised)
  } catch {
    return // not a URL this guard can judge; the provider's own admission is the next gate
  }
  if (target.origin !== dsh.origin) return
  if (target.pathname !== '/') return
  // The authenticated URL printed by `dsh web` carries a token; the bare root does not.
  if (target.searchParams.has('token')) return
  throw new Error(
    'dsh_browser_open: refusing the bare DSH web root (' + dsh.origin + '/) because it carries no '
    + 'authentication token, so it answers with a 401 page that reads like a real site. Open the '
    + 'target site instead; to open DSH itself, use the authenticated URL printed by `dsh web`.',
  )
}

/**
 * Read a target's `index`, refusing the values that cannot mean anything.
 *
 * The index is looked up in the page (`els[index] ?? null`), so a negative one — `-1`, the
 * common "give me the last one" shorthand — matches nothing. The page script then treated
 * that as "not on the page yet" and polled for its whole 10s budget before reporting
 * "element not found", which reads like a slow page rather than a bad argument. Refusing it
 * here names the real problem immediately.
 * @param target - the caller's target, or undefined when there is none.
 * @returns the index, or undefined to let the page default to 0.
 */
function targetIndex(target: { readonly index?: unknown } | undefined): number | undefined {
  const index = target?.index
  if (index === undefined) return undefined
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`target.index must be a non-negative integer (got ${JSON.stringify(index)}); it is a 0-based position among the matches, and negative values such as -1 match nothing — pass the position you want, or narrow the selector`)
  }
  return index
}

/**
 * The task key for a tool call: the calling DSH session id, or the shared
 * default key when the call carries no agent context (CLI probes, tests).
 * @param exec - the tool-execution context; only its optional agent id is read.
 */
function taskKey(exec: { agent?: { id?: string } } | undefined): string {
  return exec?.agent?.id ?? 'default'
}

const effectProperties = {
  verified: { type: 'boolean' as const, description: 'Whether a visible change was observed. Absent when it could not be checked.' },
  note: { type: 'string' as const, description: 'Why the effect is uncertain.' },
}

async function pageFingerprint(browser: NonNullable<Context['browser']>, session: BrowserSessionId): Promise<string | undefined> {
  try {
    const result = await browser.execute(session, {
      script: `(() => {
        const a = document.activeElement
        return JSON.stringify([
          location.href, document.title,
          a ? [a.tagName, a.id || a.getAttribute('name') || a.className || '',
            typeof a.value === 'string' ? a.value.length : null, a.checked, a.selectedIndex,
            a.selectionStart, a.selectionEnd, a.scrollLeft, a.scrollTop] : null,
          window.scrollX, window.scrollY,
          document.body ? document.body.childElementCount : 0,
          document.body ? document.body.innerHTML.length : 0,
        ])
      })()`,
    })
    return result.ok && typeof result.value === 'string' ? result.value : undefined
  } catch {
    return undefined
  }
}

async function observedEffect(browser: NonNullable<Context['browser']>, session: BrowserSessionId, before: string | undefined): Promise<{ verified?: boolean; note?: string }> {
  const after = await pageFingerprint(browser, session)
  if (before === undefined || after === undefined) return { note: 'The effect could not be checked.' }
  return before !== after
    ? { verified: true }
    : { verified: false, note: 'No visible change observed; the effect is uncertain.' }
}

function effectText(value: { verified?: boolean; note?: string }): string {
  return value.verified === true ? ' Visible change observed.' : ` ${value.note ?? 'The effect could not be checked.'}`
}

function rememberSession(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string, agent: ExecAgent | undefined, session: BrowserSessionId | undefined, panelUrl?: string): void {
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
async function ensureSession(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string, agent?: ExecAgent, create = false): Promise<BrowserSessionId> {
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
  if (state.panelUrlByTask.has(key)) {
    throw new Error('dsh-builtin-browser: the panel surface has no live CDP session for this operation. '
      + 'Use the CDP-backed DSH desktop sidebar with a connected desktop bridge and call dsh_browser_open again. '
      + 'The Web iframe panel cannot provide live snapshots, a11y, content, scrape, screenshots, interactions, '
      + 'uploads, downloads, or reference capture. Reading tools never start a separate browser.')
  }
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

/** Coerce a tool-provided string value back to boolean/number only when lossless. */
function parseFillValue(v: string | undefined): string | number | boolean {
  if (v === 'true') return true
  if (v === 'false') return false
  // Deliberately NOT coerced to a number. The description says numbers are accepted in
  // string form, and callers pass account numbers, postcodes and zero-padded ids through
  // here: "007" became "7" and "1e3" became "1000", which silently rewrote the value they
  // meant to type. A numeric-looking string is a string; the DOM decides how to store it.
  return v ?? ''
}

/**
 * Format a snapshot element list for the model.
 *
 * Coordinates are opt-in. They are only meaningful to a caller that intends to
 * click a pixel position, which means a vision pass; for the far more common case
 * of locating an element by role/label and passing a semantic target, they are the
 * bulkiest and least useful part of every line. Omitting them keeps the listing
 * readable — which is exactly what a model without image input has to work from.
 * @param snapshot - the snapshot payload.
 * @param options - `coords: true` to include each element's viewport position.
 */
function formatSnapshot(snapshot: {
  url: string
  title?: string
  elements: readonly { ref: number; kind: string; label: string; x: number; y: number; frame?: boolean; selector?: string }[]
  truncated?: boolean
  challenge?: { blocked: boolean; kind?: string; reason?: string }
  blank?: boolean
  note?: string
  canvas?: boolean
}, options: { coords?: boolean } = {}): string {
  const showCoords = options.coords === true
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label}${el.selector !== undefined && el.selector !== '' ? ` {${el.selector}}` : ''}${el.frame === true ? ' (iframe)' : ''}${showCoords ? ` (${el.x},${el.y})` : ''}`)
  const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}`
  // A blank page, a canvas page and a page with nothing interactive are three different facts, and
  // the old wording reported all of them as "no interactive elements found" — which reads as a
  // successful look. Each now says what it is and what to do next.
  const body = snapshot.blank === true
    ? `BLANK PAGE: ${snapshot.note ?? 'nothing has been opened in this browser'}. `
      + 'Do not drive this page — open a URL first (`dsh_browser_open`).'
    : snapshot.canvas === true
      ? `CANVAS PAGE: ${snapshot.note ?? 'this page draws its interface on a canvas'}. `
        + 'A DOM snapshot cannot describe it; use `dsh_browser_screenshot` and coordinate clicks.'
      : lines.length > 0 ? lines.join('\n') : '(no interactive elements found)'
  const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : ''
  const banner = snapshot.challenge?.blocked === true
    ? `\n\nCHALLENGE: ${snapshot.challenge.reason ?? 'human-verification'}. Do NOT keep retrying — ask the human to complete it in the shared browser window, then re-snapshot.`
    : ''
  return `${header}\n\n${body}${tail}${banner}`
}

/** Register all browser tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? 60_000
  const surface = config.surface ?? 'core'
  /**
   * Longest wait `dsh_browser_wait` may poll for, leaving room for the tool call itself to
   * finish and report.
   *
   * `dsh_browser_wait` promises a VERDICT — `{ready:false, reason}` — and the enclosing tool
   * call aborts at `timeoutMs`. A caller-supplied budget longer than that aborted the call
   * instead, so the documented verdict never arrived. Clamping to just inside the budget is
   * what keeps the promise: the polling stops, the reason is returned.
   */
  const maxWaitMs = Math.max(250, timeoutMs - 5_000)
  /**
   * Most fields `dsh_browser_fill` accepts in one batch.
   *
   * The batch runs as ONE page evaluation, so hundreds of fields do not produce hundreds of
   * per-field verdicts — they produce a single evaluate that exceeds the tool budget and
   * throws, which is the opposite of the documented "per-field failures are reported instead
   * of throwing". Real forms are far smaller than this; anything larger should be split.
   */
  const maxFillFields = 200
  // Per-context state: sessions, in-flight opens, and the restriction are
  // scoped to THIS plugin apply, so parallel contexts never share sessions
  // or leak restrictions into each other.
  const state = createState()
  const takeovers = new BrowserTakeovers()
  installTakeovers(ctx, takeovers)
  liveStates.add(state)
  ctx.effect(() => () => { liveStates.delete(state) })
  // Re-apply resets the restriction: an omitted allowedActions lifts it.
  state.configRestrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined

  ctx.systemPrompt.section({
    name: 'tool:browser-human-takeover',
    order: 152,
    text: 'For CAPTCHAs, sliders, logins, two-factor authentication (2FA), and payments, call dsh_browser_request_takeover with a clear reason and any instructions. Never attempt automatic CAPTCHA or slider solving. Wait for the human, then re-read the fresh page summary and inspect the page before continuing. A skipped or cancelled takeover is not successful completion; do not bypass it or retry protected actions automatically.',
  })

  ctx.systemPrompt.section({
    name: 'tool:dsh-browser-reference-presentation',
    order: 151,
    text: 'Browser references are already displayed as interactive capsules. The capsules provide source navigation. Do not repeat browser-reference markers, dsh-browser-ref: URIs, source URLs, or source/citation links in replies; answer using the quoted content instead.',
  })

  ctx.systemPrompt.section({
    name: 'tool:dsh-builtin-browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: surface === 'code'
      ? CODE_PROMPT
      : surface === 'core'
      ? CORE_PROMPT
      : 'Use dsh_browser_* tools to operate the built-in browser. Each task has its own session and window (real toolbar): the human can watch and take over, and other tasks\' pages are not visible to you. Map a page with dsh_browser_a11y (semantic roles/names/states) or dsh_browser_snapshot (numbered elements), then drive it: dsh_browser_click/dsh_browser_type take a target {by: css|text|xpath, value}, or coordinates from dsh_browser_screenshot. Prefer dsh_browser_fill (batch) or dsh_browser_set_value/check/select/clear for forms; verify with dsh_browser_get_value. Use dsh_browser_scrape (not hand-written dsh_browser_execute) for list pages; dsh_browser_wait after slow navigation. Use dsh_browser_do for a run of steps, dsh_browser_assert to check results, and dsh_browser_console/network when the screen is unclear. Say what you are doing on the page. On a CAPTCHA (dsh_browser_challenge), stop retrying and ask the human to solve it in the browser window, then re-check.',
  })

  /**
   * Register one tool, turning a name collision into a warning instead of a dead apply.
   *
   * Registering the tools in sequence without this is how ONE taken name becomes thirty-two
   * missing ones: the throw aborts the rest of the apply, and what the user sees is a plugin that
   * half-exists. That is precisely the shape of the failure reported against a sibling plugin,
   * where the first spec collided and all six vanished behind a `console.warn` a desktop user
   * never sees.
   *
   * A name this plugin cannot have is worth a sentence in the log, not the toolset.
   * @param definition - the tool to register.
   */
  // One store for this apply: it caches by mtime, so reading it per download is a stat, not a parse.
  const settingsStore = new SettingsStore()

  // Built on first use, not at apply time: the provider is registered by another plugin's apply,
  // and a tool registered before the browser exists must still work once it does.
  let referenceService: BrowserReferenceService | undefined
  const references = (): BrowserReferenceService => {
    if (referenceService !== undefined) return referenceService
    const browser = ctx.get('browser')
    if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
    // Keep the SAME image fallback as the floating bar and the HTTP capture
    // (browser-electron/entry.ts): a clipped visible-region read lets an image
    // whose source URL cannot be downloaded still become a real reference.
    referenceService = createReferenceService(browser, {
      visibleCapture: async (sessionId, clip, signal) => {
        const shot = await browser.screenshot(sessionWireId(resolveSessionHandle(sessionId)), { clip, format: 'png' }, signal)
        return { dataUrl: shot.dataUrl, mime: 'image/png' }
      },
    })
    return referenceService
  }
  const referenceCarrier = (): BrowserReferenceCarrier => {
    const channel = settingsStore.get().browser.channel
    return channel === 'sidebar' || channel === 'chrome' || channel === 'edge' ? channel : 'bundled'
  }

  const catalog = new Map<string, CatalogTool>()
  const loaded = new Set<string>()
  const registerSafely = (definition: ReturnType<typeof defineTool>): void => {
    try {
      const execute = definition.execute.bind(definition)
      const name = definition.name
      definition = { ...definition, execute: async (args, exec) => {
        const owner = taskKey(exec)
        if (name !== TAKEOVER_TOOL && takeovers.blocks(owner)
          && (!READ_ONLY_TOOLS.has(name) || ['dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_reference_reveal'].includes(name))) {
          const requested = (args as { tabId?: string }).tabId
          let tab = requested
          if (requested?.startsWith('dsh-tab:')) {
            const session = state.sessionsByTask.get(owner)
            if (session) tab = resolveTabHandle(browserSessionHandle(owner, session), requested).tab
          }
          if (tab === undefined || takeovers.blocks(owner, tab)) {
            throw new Error('Browser tab is awaiting human takeover. Agent browser actions are refused until the human confirms completion or skips the request.')
          }
        }
        return execute(args, exec)
      } }
      catalog.set(definition.name, definition as unknown as CatalogTool)
      if (surface === 'tools' || definition.name === TAKEOVER_TOOL || (surface === 'core' && CORE_TOOLS.has(definition.name))) {
        ctx.tools.register(definition)
        loaded.add(definition.name)
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-builtin-browser: could not register ${definition.name} (${String(error)}). Another `
        + 'plugin has probably taken that name — browser tool names are a shared namespace. The '
        + 'rest of this plugin\'s tools are unaffected.',
      )
    }
  }

  registerSafely(defineTool({
    name: 'dsh_browser_request_takeover',
    description: 'Hand the selected visible sidebar browser tab in this conversation to the human for a CAPTCHA/slider, login, 2FA or payment. Works on the Web iframe without CDP, including user-opened tabs: adopts the selected tab for this request only, without granting agent control. Never solve CAPTCHAs automatically. Requires an active turn; waits for the sidebar connection and the native card or sidebar Confirm/Skip. Repeated calls on the same tab share one request. Returns done/skipped/cancelled plus a fresh page summary; inspect it before resuming. Never treat skipped/cancelled as success.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why the human must take over (1–1000 characters).' },
      instructions: { type: 'string', description: 'Optional concise instructions for the human (up to 2000 characters).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      outcome: { type: 'string', required: true, enum: ['done', 'skipped', 'cancelled'] },
      page: { type: 'object', required: true, additionalProperties: false, properties: {
        url: { type: 'string', required: true }, title: { type: 'string', required: true },
        snapshotHint: { type: 'string', required: true }, fresh: { type: 'boolean', required: true },
      } },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent?.session) throw new Error('Browser takeover requires an active agent turn.')
      if (!args.reason.trim()) throw new Error('Browser takeover reason must not be empty.')
      if (args.reason.length > 1000 || (args.instructions?.length ?? 0) > 2000) throw new Error('Browser takeover reason or instructions are too long.')
      const owner = taskKey(exec)
      const opening = state.pendingPanelOpens.get(owner)
      if (opening) await opening
      const open = getLastOpen()
      const navigationUrl = open?.owner === owner && Date.now() - open.at < 10000 ? open.url : undefined
      const page = await takeovers.adopt(owner, exec.signal, navigationUrl)
      if (navigationUrl !== undefined && getLastOpen()?.owner === owner) clearLastOpen(open!.at)
      return takeovers.run(page, args.reason.trim(), args.instructions, exec.signal, async pending => {
        const approval = ctx.get('approval' as never) as unknown as { request(request: {
          agent: ToolRunContext['agent']; toolName: string; reason: string; displayReason: { en: string; zh: string };
          callId: ToolRunContext['callId']; signal: AbortSignal;
        }): Promise<TakeoverDecision> } | undefined
        let decision: TakeoverDecision = 'unavailable'
        try {
          if (approval) decision = await approval.request({ agent: exec.agent, toolName: TAKEOVER_TOOL, callId: exec.callId,
            reason: pending.reason, displayReason: {
              en: `Please take over the browser: ${pending.reason}. When finished, click Allow once or Confirm completion in the sidebar.${pending.instructions ? '\n' + pending.instructions : ''}`,
              zh: `请接管浏览器：${pending.reason}（完成后点「允许一次」或侧栏「确认完成」）${pending.instructions ? '\n' + pending.instructions : ''}`,
            }, signal: pending.controller.signal })
        } finally { pending.controller.abort() }
        const outcome = decision === 'allowed-once' ? 'done' : decision === 'rejected' ? 'skipped' : 'cancelled'
        const unavailable = (error: unknown): TakeoverSummary => ({ url: page.url, title: '', snapshotHint: `Live page summary unavailable: ${String(error).slice(0, 300)}. Re-read the page before continuing.`, fresh: false })
        if (exec.signal.aborted) return { outcome: 'cancelled', page: unavailable('turn stopped') }
        pending.phase = 'summary'
        let fresh: TakeoverSummary
        try {
          if (!page.pageId.startsWith('iframe:')) {
            const browser = ctx.get('browser')!
            const session = await browser.bindPanelPage(`session-${page.owner}`, page.pageId)
            const snapshot = await browser.snapshot(session, AbortSignal.any([exec.signal, AbortSignal.timeout(5000)]))
            fresh = { url: snapshot.url, title: (snapshot.title ?? '').slice(0, 1000), snapshotHint: formatSnapshot(snapshot, {}).slice(0, 1500), fresh: true }
          } else {
            fresh = await new Promise<TakeoverSummary>((resolve, reject) => {
              const finish = (value?: TakeoverSummary, error?: unknown): void => {
                clearTimeout(timer); exec.signal.removeEventListener('abort', abort)
                if (error !== undefined) reject(error); else resolve(value!)
              }
              const abort = (): void => { finish(undefined, exec.signal.reason) }
              const timer = setTimeout(() => { finish(undefined, new Error('sidebar summary timed out')) }, 8000)
              exec.signal.addEventListener('abort', abort, { once: true })
              void pending.summary.then(value => { finish(value) })
              if (exec.signal.aborted) abort()
            })
          }
        } catch (error) { fresh = unavailable(error) }
        return { outcome: exec.signal.aborted ? 'cancelled' : outcome, page: fresh }
      })
    },
  }))

  // The start page's shared shortcut list, reached through the settings section the
  // sidebar edits. Built lazily for the same reason `references()` is: the settings
  // service is registered by another entry and may not exist yet at apply time.
  const startpageShortcuts = createShortcutStore(() => ctx.get('settings') as unknown as ShortcutSettings | undefined)
  registerSafely(defineTool({
    name: 'dsh_browser_shortcuts',
    description: 'Read or edit the Sidebar Browser start page shortcuts — the shared website entries a human sees on an empty tab. action=list returns them, action=add appends one (title + http(s) url required, http:// or https:// only, at most 48 entries), action=remove drops one by id. The list is shared with the sidebar UI: an entry added here appears on the next empty tab for every conversation, and one a human adds appears here.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove'], description: 'list the shortcuts, add one, or remove one by id.' },
      title: { type: 'string', description: 'Display title (add). At most 80 characters.' },
      url: { type: 'string', description: 'Destination (add): a full http:// or https:// address.' },
      id: { type: 'string', description: 'Shortcut id (remove), as returned by list or add.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shortcuts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                iconKey: { type: 'string' },
              },
            },
          },
          changed: { type: 'string', description: 'What the call changed: added <id>, removed <id>, or empty for list.' },
        },
      },
      render: (_args, value) => {
        const rows = value.shortcuts as Array<{ id: string; title: string; url: string }>
        const changed = typeof value.changed === 'string' && value.changed !== '' ? `${value.changed}\n` : ''
        const body = rows.length === 0
          ? '(the start page has no shortcuts)'
          : rows.map(row => `- ${row.title} -> ${row.url}  [${row.id}]`).join('\n')
        return [{ type: 'text', text: `${changed}${rows.length} shortcut(s):\n${body}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_shortcuts', taskKey(exec))
      try {
        if (args.action === 'list') {
          const reading = startpageShortcuts.list()
          return { shortcuts: reading.shortcuts.map(row => ({ ...row })), changed: '' }
        }
        if (args.action === 'add') {
          const result = await startpageShortcuts.add({ title: args.title, url: args.url })
          return { shortcuts: result.shortcuts.map(row => ({ ...row })), changed: `added ${result.shortcut.id}` }
        }
        if (typeof args.id !== 'string' || args.id === '') throw new Error('remove needs the shortcut id')
        const result = await startpageShortcuts.remove(args.id)
        return {
          shortcuts: result.shortcuts.map(row => ({ ...row })),
          changed: result.removed ? `removed ${args.id}` : `${args.id} was not in the list`,
        }
      } catch (error) {
        // The store reports refusals as typed errors; a tool must not answer with a stack.
        throw new Error(`start page shortcuts: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_open',
    description: 'Open a URL on the selected surface (default: panel). The CDP-backed desktop sidebar returns a live snapshot and supports subsequent browser tools on that same page. The Web iframe panel only queues sidebar navigation: carrier=panel-iframe-navigation-requested, with no snapshot or live-control capability. Reading tools never start another browser. newTab is optional on CDP surfaces. Never treat the bare DSH host (e.g. http://127.0.0.1:3080/) as the target — it needs the authenticated URL printed by `dsh web`, and the bare root is refused.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
      // Explicit per-call surface. "panel" (default) places the page in the DSH sidebar and opens no
      // window; "builtin" drives the plugin's own browser, which is what debugging DSH itself needs.
      surface: { type: 'string', enum: ['panel', 'builtin'], description: 'panel (default): the DSH sidebar only; builtin: the plugin browser, for debugging DSH itself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          carrier: { type: 'string' },
          truncated: { type: 'boolean' },
          elements: {
            type: 'array',
            required: true,
            // Same shared item schema as dsh_browser_open's, so the two cannot drift apart.
            items: ELEMENT_ITEM_SCHEMA,
          },
          challenge: {
            type: 'object',
            additionalProperties: false,
            properties: {
              blocked: { type: 'boolean', required: true },
              kind: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
      // dsh_browser_open is an overview of what just loaded, not a locator: it has no
      // `coords` parameter, so coordinates stay off here (dsh_browser_snapshot owns
      // that switch for callers that actually target pixels).
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value, {}) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // opens tabs / navigates; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_open', taskKey(exec))
      assertNotBareDshWebUrl(args.url)
      // ONE surface per open. On the Web shell the reader's sidebar is the browsing surface; opening the
      // plugin's own browser as well produced two live views of the same page (reported as "you opened the
      // built-in browser AND the sidebar at once"). `browser.surface` decides: "panel" (default on Web)
      // places the page in the sidebar and opens no window; "builtin" is the debugging surface.
      const surfaceHint = (args as { surface?: 'panel' | 'builtin' }).surface
      const surface = enforceSurface(surfaceHint ?? readSurface(), args.url)
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      if (surface === 'panel') {
        const preceding = state.pendingPanelOpens.get(key)
        let previous: BrowserSessionId | undefined
        let session: BrowserSessionId | undefined
        const opening = (async () => {
          await preceding
          await state.pendingOpens.get(key)
          previous = state.sessionsByTask.get(key)
          const target = new URL(args.url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('dsh_browser_open: panel requires an HTTP/HTTPS URL')
          exec.signal?.throwIfAborted()
          session = state.panelUrlByTask.has(key) && previous !== undefined && browser.exists(previous)
            ? previous : await browser.openPanel?.(key)
          if (session === undefined) {
            assertSurfaceCanHost(surface, args.url)
            exec.signal?.throwIfAborted()
            setLastOpen(args.url, Date.now(), key)
            rememberSession(browser, state, key, agentOf(exec), undefined, args.url)
            return { url: args.url, carrier: 'panel-iframe-navigation-requested', title: '', elements: [], truncated: false }
          }
          await browser.openUrl(session, { url: args.url, ...args.newTab === true ? { newTab: true } : {} }, exec.signal)
          const snapshot = await browser.snapshot(session, exec.signal)
          exec.signal?.throwIfAborted()
          rememberSession(browser, state, key, agentOf(exec), session, args.url)
          return {
            url: snapshot.url,
            ...snapshot.title !== undefined ? { title: snapshot.title } : {},
            elements: snapshot.elements.map(el => projectElement(el)),
            truncated: snapshot.truncated,
            ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
          }
        })()
        const pending = opening.then(() => {})
        state.pendingPanelOpens.set(key, pending)
        void pending.catch(() => {})
        try { return await opening } catch (error) {
          if (session !== undefined && session !== previous) await browser.close(session).catch(() => {})
          throw error
        } finally {
          if (state.pendingPanelOpens.get(key) === pending) state.pendingPanelOpens.delete(key)
        }
      }
      await state.pendingPanelOpens.get(key)
      await state.pendingOpens.get(key)
      if (state.panelUrlByTask.has(key)) {
        const previous = state.sessionsByTask.get(key)
        state.sessionsByTask.delete(key)
        state.panelUrlByTask.delete(key)
        if (previous !== undefined) await browser.close(previous)
      }
      const session = await ensureSession(browser, state, key, agentOf(exec), true)
      try {
        await browser.openUrl(session, {
          url: args.url,
          ...args.newTab === true ? { newTab: true } : {},
        }, exec.signal)
      } catch (error) {
        // The human's browser is already running on its own profile: the launch hands the request over and
        // exits with code 0. A new window opened inside THEIR browser with their logins — what "use my
        // Edge" means — it is simply not driveable, because their instance has no debugging port.
        const message = error instanceof Error ? error.message : String(error)
        if (!/exited immediately after launch \(exit code 0\)/u.test(message)) throw error
        return { url: args.url, carrier: 'launched-user-profile', title: '', elements: [], truncated: false }
      }
      // Hand the page to the Web sidebar as well. The desktop shell is told through the bridge; the Web
      // shell has no such channel, so the client polls this slot and places the tab itself. Written in the
      // TOOL (not a provider) on purpose: every open passes through here whatever serves it.
      try { setLastOpen(args.url, Date.now()) } catch { /* best effort */ }
      let snapshot: Awaited<ReturnType<typeof browser.snapshot>>
      try {
        snapshot = await browser.snapshot(session, exec.signal)
      } catch (error) {
        // The human's browser is ALREADY running on its own profile, so a launch hands the request over
        // and the launcher exits with code 0. That is not a failure: a new window opened inside THEIR
        // browser, with their logins, which is exactly what "use my Edge" means. It is only undriveable,
        // because their instance has no debugging port. Report the page, not an error.
        const message = error instanceof Error ? error.message : String(error)
        if (!/exited immediately after launch \(exit code 0\)/u.test(message)) throw error
        return {
          url: args.url,
          carrier: 'launched-user-profile',
          title: '',
          elements: [],
          truncated: false,
        }
      }
      return {
        url: snapshot.url,
        carrier: String((globalThis as unknown as Record<string, unknown>).__dshBrowserCarrier ?? 'bundled'),
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => projectElement(el)),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_snapshot',
    description: 'Return an AI-friendly snapshot of the current shared-browser page: numbered interactive elements (inputs, buttons, links) the model can cite. This is the primary way to understand a page, and it needs no image input — every listed element can afterwards be addressed by a semantic target (dsh_browser_click, dsh_browser_type, dsh_browser_check, …) rather than by coordinates.',
    parameters: {
      coords: { type: 'boolean', description: 'Also print each element\'s viewport coordinates. Off by default; only useful when a vision pass is going to click a pixel position.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          truncated: { type: 'boolean' },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'number', required: true },
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                x: { type: 'number', required: true },
                y: { type: 'number', required: true },
                frame: { type: 'boolean' },
                // The page-side script computes this for every element and the tool layer
                // passes it through. Without it in the schema, a declared
                // additionalProperties: false rejects the whole result at run time — which is
                // how this was found, on the very first real call, after a static review had
                // called the change verified.
                selector: { type: 'string' },
              },
            },
          },
          challenge: {
            type: 'object',
            additionalProperties: false,
            properties: {
              blocked: { type: 'boolean', required: true },
              kind: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatSnapshot(value, { coords: args.coords === true }) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const session = await ensureSession(browser, state, key, agentOf(exec))
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => projectElement(el)),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_a11y',
    description: 'Read the accessibility tree: every interactive node with its role (button/link/textbox/checkbox/…), accessible name, value, and states (enabled/checked/expanded/…); coordinates only with coords: true. Prefer this over dsh_browser_snapshot to understand structure and find the right element — roles and names say WHAT each node is, and the name is what dsh_browser_click matches when targeting by text. Penetrates same-origin iframes and shadow roots.',
    parameters: {
      includeHidden: { type: 'boolean', description: 'Include hidden elements (default false).' },
      maxNodes: { type: 'number', description: 'Maximum nodes (default 150, range 10-5000).' },
      coords: { type: 'boolean', description: 'Include each element\'s viewport coordinates. Off by default: a semantic target needs no coordinates, and they are pure noise unless a vision pass is going to click a pixel position.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          count: { type: 'number', required: true },
          truncated: { type: 'boolean' },
          nodes: {
            type: 'array',
            required: true,
            // Same shared table as the node projection.
            items: NODE_ITEM_SCHEMA,
          },
        },
      },
      render: (args, value) => {
        const nodes = value.nodes as Array<{ ref: number; role: string; name: string; value?: string | null; states: string[]; depth: number; tag: string; x: number; y: number; frame?: boolean; selector?: string }>
        // Built for reading, not for imaging: containment is shown as indentation
        // (the depth was already collected and simply thrown away), an empty state
        // list adds nothing, and coordinates appear only when asked for — a model
        // working from the DOM never needs them, and they are the bulkiest part of
        // every line.
        const showCoords = args.coords === true
        const lines = nodes.map(n => {
          const valuePart = n.value !== undefined && n.value !== null ? ` value="${String(n.value).slice(0, 60)}"` : ''
          // One space per level, not two: indentation was 19.7% of a measured 38,953-character
          // result, and DOM depth is not a11y depth — deep wrapper divs push it to the cap.
          const indent = ' '.repeat(Math.max(0, Math.min(8, Number(n.depth) || 0)))
          const coordsPart = showCoords ? ` (${n.x},${n.y})` : ''
          // Only states that are not the default. `states=[enabled]` was printed on 405 of 500
          // nodes whose state WAS the default — 22% of the output for no information. Absence
          // now means "enabled", which the description states.
          const notableStates = Array.isArray(n.states) ? n.states.filter((state: string) => state !== 'enabled') : []
          const statePart = notableStates.length > 0 ? ` states=[${notableStates.join(',')}]` : ''
          // The provider computes this for a node with an id or a name; printing it is what
          // makes the node something the caller can point at instead of guessing at its text.
          const selectorPart = typeof n.selector === 'string' && n.selector !== '' ? ` {${n.selector}}` : ''
          return `${indent}[${n.ref}] ${n.role} "${n.name}"${valuePart}${coordsPart}${statePart}${selectorPart}${n.frame === true ? ' (iframe)' : ''}`
        })
        const header = `URL: ${value.url}${value.title !== undefined ? `\nTitle: ${value.title}` : ''}`
        // The "coords: true" hint used to be appended to EVERY a11y result. It already lives in
        // the parameter description, so repeating it in each model turn was pure token cost.
        return [{ type: 'text', text: `${header}\n\n${lines.length > 0 ? lines.join('\n') : '(no accessible interactive nodes)'}${value.truncated === true ? '\n(truncated)' : ''}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.a11y(session, {
        ...args.includeHidden === true ? { includeHidden: true } : {},
        ...args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {},
      }, exec.signal)
      return {
        url: result.url,
        ...result.title !== undefined ? { title: result.title } : {},
        count: result.count,
        truncated: result.truncated,
        // The projection drops `value: null` (the schema declares a string, and the contract is
        // that an absent value means "not applicable"), so the run-time shape and the inferred
        // type differ by exactly that. The field table is what keeps the schema and the
        // projection in agreement; this assertion is the type-level echo of that.
        // The projection and the schema are now generated from one field table, so the shape
        // they agree on is guaranteed at run time. TypeScript cannot see that agreement — it
        // infers the output type from the schema object and compares it against the provider's
        // interface, which describes the provider's internal shape rather than the contract
        // (`value` nullable internally, absent on the wire; `selector` required by the
        // interface, optional in the inferred schema). The assertion bridges that last gap; the
        // test that walks every registered tool is what checks the agreement for real.
        nodes: result.nodes.map(n => projectNode(n)) as never,
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_challenge',
    description: 'Check whether a human-verification challenge (CAPTCHA / bot detection: Cloudflare "Just a moment", reCAPTCHA, hCaptcha, Turnstile) is blocking the current page. When blocked, do NOT keep retrying automated steps — ask the human to complete the verification in the shared browser window, then re-check with dsh_browser_snapshot.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blocked: { type: 'boolean', required: true },
          kind: { type: 'string' },
          reason: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.blocked
          ? `Challenge detected: ${value.reason ?? value.kind ?? 'human-verification'}. ${value.hint ?? ''}`
          : 'No human-verification challenge detected.',
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const challenge = await browser.detectChallenge(session, exec.signal)
      return {
        blocked: challenge.blocked,
        ...challenge.kind !== undefined ? { kind: challenge.kind } : {},
        ...challenge.reason !== undefined ? { reason: challenge.reason } : {},
        hint: challenge.blocked
          ? 'Ask the human to complete the verification in the shared browser window (the page is visible to them), then re-check with dsh_browser_snapshot.'
          : '',
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_wait',
    description: 'Wait until the shared-browser page is ready: load complete, and optionally the expected URL and/or a CSS selector present (top document or same-origin iframes). Use after dsh_browser_open on slow sites instead of snapshotting a white page — wait for the URL you navigated to first. Returns ready=true/false with a short reason; a miss is not an error.',
    parameters: {
      timeoutMs: { type: 'number', description: 'Maximum wait in ms (default 30000).' },
      url: { type: 'string', description: 'Expected page URL (exact or prefix), e.g. the URL you opened.' },
      selector: { type: 'string', description: 'CSS selector that must exist.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ready ? 'Page ready.' : `Wait timed out: ${value.reason}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.waitFor(session, {
        // Capped so an over-budget argument returns the documented verdict (see maxWaitMs)
        // rather than aborting the whole tool call.
        ...args.timeoutMs !== undefined ? { timeoutMs: Math.min(args.timeoutMs, maxWaitMs) } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
      }, exec.signal)
      return { ready: result.ready, reason: result.reason }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_execute',
    description: 'Execute JavaScript in the shared-browser page context. This is the primary way to interact with page elements: focus, fill inputs (use the native value setter for framework-controlled inputs, then dispatch an input event), click buttons (element.click() or a constructed MouseEvent). Returns the evaluation result by value, or the exception text.',
    parameters: {
      script: { type: 'string', required: true, description: 'The JavaScript expression to evaluate in the page context.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments injected into the script scope as arguments[0..n].' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          value: { type: 'string' },
          exception: { type: 'string' },
        },
      },
      // A return value is whatever the page produced, and `document.body.outerHTML` measured
      // 157,350 characters — ~39-52k tokens from one call. Bounded, with the cut stated so the
      // caller knows to narrow the expression rather than the value being silently short.
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Exception: ${value.exception}` }]
        const rendered = String(value.value ?? '')
        const cap = 50_000
        const text = rendered.length > cap
          ? `Result: ${rendered.slice(0, cap)}\n(result truncated at ${cap} of ${rendered.length} characters — return a smaller value, or write it with dsh_browser_execute + a variable)`
          : `Result: ${rendered}`
        return [{ type: 'text', text }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // page JS can be stateful
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_execute', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.execute(session, {
        script: args.script,
        args: args.args ?? [],
      }, exec.signal)
      if (result.ok) {
        const raw = result.value
        const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
        return { ok: true, value }
      }
      return { ok: false, exception: result.exception }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_content',
    description: 'Fetch the current shared-browser page content in a chosen format: html (raw DOM), markdown (structured reading), txt (plain text), or json. Optionally scope to a CSS selector and cap the length. Use this to read page content, not to interact.',
    parameters: {
      format: { type: 'string', required: true, enum: ['html', 'markdown', 'txt', 'json'], description: 'Output format.' },
      selector: { type: 'string', description: 'CSS selector limiting the fetch to one region (e.g. #main).' },
      maxChars: { type: 'number', description: 'Maximum characters of returned content.' },
      timeoutMs: { type: 'number', description: 'Evaluation timeout in ms (default 30000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content + (value.truncated ? `\n(content truncated — narrow it with selector= or raise maxChars)` : '') }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.content(session, {
        format: args.format,
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      }, exec.signal)
      return { content: result.content, truncated: result.truncated }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_scrape',
    description: 'Extract structured data from a page: give the container CSS selector (item) and a field map (name -> selector, optionally selector@attr to take an attribute; a@href yields the absolute URL). Returns one object per item. Static CSS queries only — no arbitrary code runs — so it is safe on any page. Use for list pages (search results, cards, tables) instead of hand-writing dsh_browser_execute.',
    parameters: {
      item: { type: 'string', required: true, description: 'CSS selector of each result container (e.g. "div.card").' },
      fields: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'Field map: name -> selector[@attr] (e.g. {"title": "h3", "url": "a@href"}).',
      },
      timeoutMs: { type: 'number', description: 'Wait budget for the item selector in ms (default 5000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // Compact, unlike the pretty-printed form this used to emit: two-space indentation
        // carries no information a model can use and cost 13.7% of a measured 39,559-character
        // result. The count leads so the caller can tell a short list from a capped one.
        text: `${value.count} item(s):\n${JSON.stringify(value.items)}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_scrape', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const fields = (args.fields ?? {}) as Record<string, string>
      const result = await browser.scrape(session, {
        item: args.item,
        fields: Object.entries(fields).map(([name, selector]) => ({ name, selector })),
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      }, exec.signal)
      return { count: result.count, items: result.items.map(it => ({ ...it })) as never }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_click',
    description: 'Click in the shared browser. Prefer target {by: css|text|xpath, value, index?}: the element is located from the DOM, scrolled into view, and clicked at its centre — no image input needed, and the only form that works without vision. Alternatively x/y viewport coordinates, meaningful only after a vision model located the element on a dsh_browser_screenshot; refused under the non-visual strategy. Provide exactly one of target or x/y.',
    parameters: {
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
          value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
          index: { type: 'number', description: '0-based index of the match (default 0).' },
        },
        description: 'Locate the element semantically and click it (css/text/xpath).',
      },
      x: { type: 'number', description: 'Viewport x coordinate (CSS px), taken from a dsh_browser_screenshot read by a vision model. Prefer a semantic target — it works without image input.' },
      y: { type: 'number', description: 'Viewport y coordinate (CSS px), taken from the same screenshot as x.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' + effectText(value) : 'Click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_click', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value?: string; index?: number } | undefined
      // A target whose value is empty is a caller mistake, not a request to fall back.
      // Degrading silently sent typed text to whatever held focus — possibly a password
      // field — or dropped the semantic target in favour of coordinates.
      if (target !== undefined && typeof target.value === 'string' && target.value === '') {
        throw new Error('target.value is empty; pass a css selector, visible text or XPath, or omit target entirely to use x/y')
      }
      const index = targetIndex(target)
      const before = await pageFingerprint(browser, session)
      if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
        await browser.click(session, {
          target: {
            by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
            value: target.value,
            ...index !== undefined ? { index } : {},
          },
        }, exec.signal)
      } else {
        if (typeof args.x !== 'number' || typeof args.y !== 'number') {
          throw new Error('dsh_browser_click: provide a target (css/text/xpath) or x/y coordinates')
        }
        await browser.click(session, { x: args.x, y: args.y }, exec.signal)
      }
      return { clicked: true, ...await observedEffect(browser, session, before) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_click_sequence',
    description: 'Click many points in order, in one call. Use this instead of repeated dsh_browser_click when a page needs a run of coordinate clicks — a canvas board, a map, a drawing surface. Each point is clicked with the same real input sequence the single click uses; between points the call waits intervalMs (default 40 ms), which is what stops a page from reading two presses as a double click. Stops at the first point that fails and says where, so a run that half-landed is reported rather than looking complete.',
    parameters: {
      points: {
        type: 'array',
        required: true,
        description: 'Points to click, in order, in viewport CSS pixels — the same space dsh_browser_screenshot reports.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number', required: true, description: 'Viewport x in CSS px.' },
            y: { type: 'number', required: true, description: 'Viewport y in CSS px.' },
          },
        },
      },
      intervalMs: { type: 'number', description: 'Milliseconds between points (default 40).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'number', required: true, description: 'How many points landed.' },
          ...effectProperties,
          failedAt: { type: 'number', description: 'Index of the point that failed, when one did.' },
          error: { type: 'string', description: 'Why that point failed.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.failedAt === undefined
          ? `Clicked ${String(value.clicked)} point(s).` + effectText(value)
          : `Clicked ${String(value.clicked)} point(s), then stopped at index ${String(value.failedAt)}: ${String(value.error ?? 'unknown')}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_click_sequence', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const points = Array.isArray(args.points) ? args.points : []
      const intervalMs = typeof args.intervalMs === 'number' ? args.intervalMs : undefined
      const before = await pageFingerprint(browser, session)
      const result = await browser.clickSequence(session, { points, ...intervalMs === undefined ? {} : { intervalMs } })
      return { ...result, ...await observedEffect(browser, session, before) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_type',
    description: 'Type text into the focused element of the shared browser, or into a located element (pass target {by: css|text|xpath, value, index?} to focus it first). Text is inserted at the focus via CDP Input.insertText. For setting whole field values (and React-controlled inputs) prefer dsh_browser_set_value; use dsh_browser_key for Enter/Tab/arrows.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to insert.' },
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css).' },
          value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
          index: { type: 'number', description: '0-based index of the match (default 0).' },
        },
        description: 'Focus this element first, then type (css/text/xpath).',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` + effectText(value) : 'Type failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_type', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value?: string; index?: number } | undefined
      // A target whose value is empty is a caller mistake, not a request to fall back.
      // Degrading silently sent typed text to whatever held focus — possibly a password
      // field — or dropped the semantic target in favour of coordinates.
      if (target !== undefined && typeof target.value === 'string' && target.value === '') {
        throw new Error('target.value is empty; pass a css selector, visible text or XPath, or omit target entirely to use x/y')
      }
      const index = targetIndex(target)
      const before = await pageFingerprint(browser, session)
      if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
        await browser.type(session, {
          text: args.text,
          target: {
            by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
            value: target.value,
            ...index !== undefined ? { index } : {},
          },
        }, exec.signal)
      } else {
        await browser.type(session, { text: args.text }, exec.signal)
      }
      return { typed: true, ...await observedEffect(browser, session, before) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_scroll',
    description: 'Scroll the shared-browser page: by pixel deltas (deltaX/deltaY), to a CSS selector\'s element, or to the top/bottom. Use to reveal below-the-fold content before snapshotting or clicking.',
    parameters: {
      deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS pixels.' },
      deltaY: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' },
      selector: { type: 'string', description: 'Scroll the element matching this CSS selector into view.' },
      toTop: { type: 'boolean', description: 'Scroll to the top of the page.' },
      toBottom: { type: 'boolean', description: 'Scroll to the bottom of the page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { scrolled: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.scrolled ? 'Scrolled.' + effectText(value) : 'Scroll failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page scroll state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_scroll', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const before = await pageFingerprint(browser, session)
      await browser.scroll(session, {
        ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
        ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.toTop === true ? { toTop: true } : {},
        ...args.toBottom === true ? { toBottom: true } : {},
      }, exec.signal)
      return { scrolled: true, ...await observedEffect(browser, session, before) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_back',
    description: 'Go back one step in the shared-browser page history. A no-op when there is no previous entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { back: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.back ? 'Went back.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_back', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.back(session, exec.signal)
      return { back: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_forward',
    description: 'Go forward one step in the shared-browser page history. A no-op when there is no next entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { forward: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.forward ? 'Went forward.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_forward', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.forward(session, exec.signal)
      return { forward: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_refresh',
    description: 'Reload the current page in the shared browser (like a browser\'s refresh button). Use after a page got stuck, to apply script changes, or to re-fetch a page.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { refreshed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.refreshed ? 'Page reloaded.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // reloads the page; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_refresh', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.reload(session, exec.signal)
      return { refreshed: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_key',
    description: 'Press one named key in the shared-browser page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). Use after focusing an input to submit a chat box (Enter), move focus (Tab), or navigate a list (arrows).',
    parameters: {
      key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'], description: 'The key to press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` + effectText(value) : 'Key press failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_key', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const before = await pageFingerprint(browser, session)
      await browser.key(session, { key: args.key }, exec.signal)
      return { pressed: true, ...await observedEffect(browser, session, before) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_fill',
    description: 'Fill a form in one batch: each field takes a CSS selector or name/label/placeholder text plus its value (boolean for checkbox/radio; option value or visible text for selects and radio groups). The native setter plus input/change events fire, so React/Vue controlled inputs update. Optionally submit the form. Prefer this over hand-written dsh_browser_execute; per-field failures are reported instead of throwing.',
    parameters: {
      fields: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            selector: { type: 'string', description: 'CSS selector; when present, candidates are scoped to it.' },
            name: { type: 'string', description: 'Match by the field\'s name attribute.' },
            label: { type: 'string', description: 'Match by associated <label> text or aria-label.' },
            placeholder: { type: 'string', description: 'Match by placeholder text.' },
            kind: { type: 'string', enum: ['text', 'textarea', 'checkbox', 'radio', 'select'], description: 'Field kind; defaults to text.' },
            value: { type: 'string', required: true, description: 'Value to set (string form; booleans/numbers accepted as strings). Required: omitting it would be read as "set empty", which unchecks a checkbox and clears a text field while still reporting success.' },
          },
        },
      },
      submit: { type: 'boolean', description: 'Submit the containing form after filling (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fields: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                target: { type: 'string', required: true },
                method: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          submitted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (() => {
          const fields = value.fields as { ok: boolean; target: string; method?: string; error?: string }[]
          const failed = fields.filter(f => !f.ok)
          const lines = fields.map(f => `${f.ok ? 'OK' : 'FAIL'} ${f.target}${f.ok ? ` (${f.method ?? 'input'})` : `: ${f.error ?? 'unknown error'}`}`)
          const head = failed.length === 0
            ? `Filled ${fields.length}/${fields.length} fields${value.submitted ? ' and submitted the form' : ''}.`
            : `Filled ${fields.length - failed.length}/${fields.length} fields; ${failed.length} failed:`
          return head + '\n' + lines.join('\n')
        })(),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_fill', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const requested = args.fields ?? []
      if (requested.length > maxFillFields) {
        throw new Error(`dsh_browser_fill: ${requested.length} fields in one call exceeds the ${maxFillFields}-field limit; split it into several calls so each one can report per-field results instead of timing out as a batch`)
      }
      const fields = requested.map((f: { selector?: string; name?: string; label?: string; placeholder?: string; kind?: string; value?: string }) => {
        // A missing value is a caller mistake, not a request to clear the field. Turning
        // it into '' silently unchecks a checkbox or empties a text input while the tool
        // still reports success, so it fails loudly. The schema marks value required, but
        // a call can still arrive without it.
        if (f.value === undefined) {
          const matcher = f.selector ?? f.name ?? f.label ?? f.placeholder ?? '(no matcher)'
          throw new Error(`dsh_browser_fill: field "${matcher}" has no "value"; pass one (use "false" to uncheck, or "" to clear deliberately)`)
        }
        return {
          ...f.selector !== undefined ? { selector: f.selector } : {},
          ...f.name !== undefined ? { name: f.name } : {},
          ...f.label !== undefined ? { label: f.label } : {},
          ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
          ...f.kind !== undefined ? { kind: f.kind as 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' } : {},
          value: parseFillValue(f.value),
        }
      })
      const result = await browser.fillForm(session, {
        fields,
        ...args.submit === true ? { submit: true } : {},
      }, exec.signal)
      return {
        fields: result.fields.map(f => ({ ok: f.ok, target: f.target, ...f.method !== undefined ? { method: f.method } : {}, ...f.error !== undefined ? { error: f.error } : {} })),
        submitted: result.submitted,
      }
    },
  }))

  // ---------------------------------------------------------------------------
  // Single-control form primitives, all target-based (css/text/xpath).
  // ---------------------------------------------------------------------------
  const targetParam = {
    type: 'object' as const,
    required: true as const,
    additionalProperties: false as const,
    properties: {
      by: { type: 'string' as const, enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
      value: { type: 'string' as const, required: true as const, description: 'The CSS selector, visible text, or XPath expression.' },
      index: { type: 'number' as const, description: '0-based index of the match (default 0).' },
    },
    description: 'Locate the element (css/text/xpath).',
  }

  registerSafely(defineTool({
    name: 'dsh_browser_set_value',
    description: 'Set the value of ONE input/textarea/select/contenteditable, located by css/text/xpath. Uses the native setter plus input/change events, so React/Vue controlled inputs update correctly. For selects pass the option value or visible text. For a whole form at once prefer dsh_browser_fill.',
    parameters: {
      target: targetParam,
      value: { type: 'string', required: true, description: 'The value to set (string form; numbers/booleans accepted).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true, description: 'How the value was applied: input/textarea/select/contenteditable.' },
          value: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Set via ${value.method}.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_set_value', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.setValue(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        value: parseFillValue(args.value),
      }, exec.signal)
      return { method: result.method, value: result.value }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_check',
    description: 'Check (or uncheck, with checked=false) a checkbox or radio button, located by css/text/xpath.',
    parameters: {
      target: targetParam,
      checked: { type: 'boolean', description: 'Desired state (default true = check).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { checked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.checked ? 'Checked.' : 'Unchecked.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_check', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.check(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        ...args.checked !== undefined ? { checked: args.checked } : {},
      }, exec.signal)
      return { checked: result.checked }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_select',
    description: 'Select one option of a <select>, located by css/text/xpath — by option value, visible text, or 0-based index (provide exactly one).',
    parameters: {
      target: targetParam,
      optionValue: { type: 'string', description: 'Match the option by its value attribute.' },
      optionText: { type: 'string', description: 'Match the option by its visible text.' },
      optionIndex: { type: 'number', description: 'Match the option by its 0-based index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Selected "${value.text}".` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_select', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.selectOption(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        ...args.optionValue !== undefined ? { optionValue: args.optionValue } : {},
        ...args.optionText !== undefined ? { optionText: args.optionText } : {},
        ...args.optionIndex !== undefined ? { optionIndex: args.optionIndex } : {},
      }, exec.signal)
      return { value: result.value, text: result.text }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_clear',
    description: 'Clear an input/textarea/contenteditable, or uncheck a checkbox/radio, located by css/text/xpath.',
    parameters: {
      target: targetParam,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cleared: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.cleared ? 'Cleared.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_clear', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      await browser.clearField(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
      }, exec.signal)
      return { cleared: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_get_value',
    description: 'Read the current value of one input/textarea/select/contenteditable, located by css/text/xpath. Use to VERIFY that a fill worked (e.g. before submitting).',
    parameters: {
      target: targetParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          checked: { type: 'boolean', description: 'For checkbox/radio.' },
          selectedText: { type: 'string', description: 'For <select>.', },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (() => {
        if (value.checked !== undefined) return `checked=${value.checked}`
        if (value.selectedText !== undefined) return `selected: ${value.selectedText}`
        return `value: ${value.value ?? '(none)'}`
      })() }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_get_value', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.getValue(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
      }, exec.signal)
      return {
        ...result.value !== null ? { value: result.value } : {},
        ...result.checked !== undefined ? { checked: result.checked } : {},
        ...result.selectedText !== undefined ? { selectedText: result.selectedText } : {},
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_screenshot',
    description: 'Screenshot the Desktop browser (PNG default, JPEG where supported). Vision-capable active models receive the image directly; non-vision or unknown models receive text metadata only. Images are downscaled to at most 1280x960 and limited to 4 MiB; retry with smaller dimensions if encoding exceeds the limit. Supports fullPage and savePath. Web iframe screenshots are unavailable. Never solve CAPTCHAs automatically; request human takeover instead.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
      savePath: { type: 'string', description: 'Absolute file path to also save the image to. Must resolve inside the configured downloadDir (default: the system Downloads folder, localized names such as ~/下载 included); an existing file is never overwritten.' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png; jpeg needs the self-hosted browser or an installed Chrome/Edge; the desktop sidebar returns PNG because the Electron CDP JPEG encoder hangs).' },
      quality: { type: 'number', description: 'JPEG quality 1-100 (default 80); ignored for PNG.' },
      maxWidth: { type: 'number', description: 'Downscale to fit within this width (aspect preserved).' },
      maxHeight: { type: 'number', description: 'Downscale to fit within this height (aspect preserved).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'number', required: true, description: 'Encoded screenshot byte count.' },
          attachment: {
            type: 'object', additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
          width: { type: 'number', description: 'Pixel width of the returned image, when the capture was measured (present with maxWidth/maxHeight).' },
          height: { type: 'number', description: 'Pixel height of the returned image, when the capture was measured.' },
          path: { type: 'string', description: 'The file path the screenshot was saved to, when savePath was given.' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Screenshot captured (${Math.round(value.bytes / 1024)} KiB${value.width !== undefined && value.height !== undefined ? `, ${value.width}x${value.height}` : ''})${value.path !== undefined ? ` saved to ${value.path}` : ''}.` },
        ...value.attachment === undefined ? [] : [{ type: 'image' as const, attachment: value.attachment as ImageBlock['attachment'] }],
      ],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      await state.pendingPanelOpens.get(key)
      const existing = state.sessionsByTask.get(key)
      if (state.panelUrlByTask.has(key) && (existing === undefined || !browser.exists(existing))) {
        throw new Error('Web 侧栏暂不支持截图：iframe 无法被网页静默截图 (panel surface unavailable). Use the CDP-backed DSH desktop sidebar with a connected desktop bridge for screenshots.')
      }
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const vision = await screenshotVisionEnabled(ctx, exec, exec.signal)
      const maxWidth = screenshotDimension(args.maxWidth, SCREENSHOT_MAX_WIDTH)
      const maxHeight = screenshotDimension(args.maxHeight, SCREENSHOT_MAX_HEIGHT)
      const shot = await browser.screenshot(session, {
        ...args.fullPage === true ? { fullPage: true } : {},
        ...args.savePath !== undefined ? { savePath: args.savePath } : {},
        ...args.format !== undefined ? { format: args.format } : {},
        ...args.quality !== undefined ? { quality: args.quality } : {},
        maxWidth,
        maxHeight,
      }, exec.signal)
      exec.signal?.throwIfAborted()
      const image = screenshotBytes(shot.dataUrl)
      const attachment = vision ? await saveScreenshotImage(ctx, image, maxWidth, maxHeight) : undefined
      exec.signal?.throwIfAborted()
      return {
        bytes: image.data.length,
        ...attachment === undefined ? {} : { attachment },
        ...shot.path !== undefined ? { path: shot.path } : {},
        ...shot.width !== undefined ? { width: shot.width } : {},
        ...shot.height !== undefined ? { height: shot.height } : {},
      }
    },
  }))

  if (config.tabTools !== false) {
    registerSafely(defineTool({
      name: 'dsh_browser_list_tabs',
      description: 'List the shared-browser session\'s tabs with their URLs and which is active.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  active: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.tabs as { id: string; url: string; active: boolean }[])
            .map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n'),
        }],
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const tabs = await browser.listTabs(session)
        return { tabs: scopedTabs(browserSessionHandle(taskKey(exec), session), tabs).map(t => ({ id: t.id, url: t.url, active: t.active })) }
      },
    }))

    registerSafely(defineTool({
      name: 'dsh_browser_switch_tab',
      description: 'Switch the shared browser to a tab by id (from dsh_browser_list_tabs).',
      parameters: {
        tabId: { type: 'string', required: true, description: 'The tab id to switch to.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { switched: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.switched ? 'Switched.' : 'Tab not found.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // mutates the active tab; exclusive within a task
      async execute(args, exec) {
        assertAllowed(state, 'dsh_browser_switch_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const handle = resolveTabHandle(browserSessionHandle(taskKey(exec), session), args.tabId)
        await browser.switchTab(session, tabWireId(handle))
        return { switched: true }
      },
    }))

    registerSafely(defineTool({
      name: 'dsh_browser_close_tab',
      description: 'Close a tab in the shared browser by id. Closing the active tab activates the next.',
      parameters: {
        tabId: { type: 'string', required: true, description: 'The tab id to close.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.closed ? 'Closed.' : 'Tab not found.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // mutates the tab list; exclusive within a task
      async execute(args, exec) {
        assertAllowed(state, 'dsh_browser_close_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const handle = resolveTabHandle(browserSessionHandle(taskKey(exec), session), args.tabId)
        await browser.closeTab(session, tabWireId(handle))
        return { closed: true }
      },
    }))

    registerSafely(defineTool({
      name: 'dsh_browser_reset',
      description: 'Close every tab in the shared browser and start fresh with one blank tab.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser reset.' : 'Failed.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // closes every tab; exclusive within a task
      async execute(_args, exec) {
        assertAllowed(state, 'dsh_browser_reset', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        await browser.reset(session)
        return { reset: true }
      },
    }))
  }

  registerSafely(defineTool({
    name: 'dsh_browser_history',
    description: 'List the shared browser session\'s recorded operation history (navigate/execute/click/type), newest last, with per-step success/error. Use to understand what the agent did and to pick a step to replay.',
    parameters: {
      verbose: { type: 'boolean', description: "Include each operation's parameters (default false). They are what you just sent, so they are omitted unless asked for." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number', required: true },
                action: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                params: { type: 'object', additionalProperties: true, required: true },
                result: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const entries = value.entries as Array<{ seq: number; action: string; ok: boolean; params: Record<string, unknown>; result?: string; error?: string }>
        if (entries.length === 0) return [{ type: 'text', text: '(no recorded operations yet)' }]
        // The parameters are what the caller itself just sent, so echoing them back is cost
        // without information — measured at 18,162 characters for 200 operations, of which the
        // per-entry params dominated. Only the tail is shown by default: the recent steps are
        // what a caller reasons about, and the count leads so the tail is not mistaken for all.
        const recent = entries.slice(-20)
        const omitted = entries.length - recent.length
        const lines = recent.map(e => `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}${args.verbose === true ? ` ${JSON.stringify(e.params)}` : ''}`)
        const header = omitted > 0
          ? `${entries.length} operations recorded; showing the last ${recent.length} (${args.verbose === true ? '' : ' (pass verbose: true for parameters)'}):`
          : `${entries.length} operation(s):`
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const entries = await browser.history(session)
      const rendered = entries.map(e => {
        const params = JSON.parse(JSON.stringify(e.params)) as Record<string, unknown>
        // Typed text / set values (possibly passwords) are kept verbatim in
        // the provider's history so replay can re-issue them, but must not be
        // echoed back to the model: mask them in the tool output, preserving
        // the length.
        if (e.action === 'type' && typeof params.text === 'string') {
          params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`
        }
        if (e.action === 'setValue' && typeof params.value === 'string') {
          params.value = '*'.repeat(Math.min(params.value.length, 64)) + ` (${params.value.length} chars)`
        }
        // Replay of type/setValue carries the same sensitive fields.
        if (e.action === 'replay' && params.of === 'type' && typeof params.text === 'string') {
          params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`
        }
        // Execute scripts may embed form tokens / credentials; mask script,
        // args, and result for both direct execute and replay-of-execute.
        const isExecute = e.action === 'execute' || (e.action === 'replay' && params.of === 'execute')
        if (isExecute) {
          if (typeof params.script === 'string') {
            params.script = `/* ${params.script.length} chars redacted */`
          }
          if (Array.isArray(params.args)) {
            params.args = params.args.map(() => '***')
          }
        }
        const row: { seq: number; action: string; ok: boolean; params: unknown; result?: string; error?: string } = {
          seq: e.seq,
          action: e.action,
          ok: e.ok,
          params,
        }
        if (isExecute && typeof e.result === 'string') {
          row.result = `[${e.result.length} chars redacted]`
        } else if (e.result !== undefined) {
          row.result = e.result
        }
        if (e.error !== undefined) row.error = e.error
        return row
      })
      return { entries: rendered as never }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_visited',
    description: 'List pages the shared browser has visited, newest first, from the PERSISTENT browsing history: it survives closing the browser and restarting DSH, so it is how you (or the human) find a page again afterwards. Reopen one by passing its url to dsh_browser_open. Not to be confused with dsh_browser_history, which is only the current session\'s operation log (navigate/click/type) and disappears with the session.',
    parameters: {
      limit: { type: 'number', description: 'Maximum entries to return (default 30, capped at 200).' },
      domain: { type: 'string', description: 'Only visits whose hostname contains this text (case-insensitive).' },
      query: { type: 'string', description: 'Only visits whose URL or title contains this text (case-insensitive).' },
      session: { type: 'string', description: 'Only visits recorded by this task/session label — use it to separate your own pages from another session\'s or the human\'s.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'number', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string' },
                session: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const entries = value.entries as Array<{ at: number; url: string; title?: string; session?: string }>
        let lastSession: string | undefined
        if (entries.length === 0) {
          return [{ type: 'text', text: '(no recorded visits — nothing has been browsed yet, or history recording is turned off in settings)' }]
        }
        return [{
          type: 'text',
          text: entries.map(entry => {
            const when = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 16)
            const title = entry.title !== undefined ? `${entry.title} — ` : ''
            const tag = entry.session !== undefined && entry.session !== lastSession
              ? `  [session ${entry.session.slice(0, 8)}]`
              : ''
            lastSession = entry.session
            return `${when}  ${title}${entry.url}${tag}`
          }).join('\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 30
      const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)))
      const domain = typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain.trim() : undefined
      const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
      const session = typeof args.session === 'string' && args.session.trim() !== '' ? args.session.trim() : undefined
      const entries = browser.visited({
        limit,
        ...domain !== undefined ? { domain } : {},
        ...query !== undefined ? { query } : {},
        ...session !== undefined ? { session } : {},
      })
      return {
        count: entries.length,
        entries: entries.map(entry => ({
          at: entry.at,
          url: entry.url,
          ...entry.title !== undefined ? { title: entry.title } : {},
          ...entry.session !== undefined ? { session: entry.session } : {},
        })),
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_replay',
    description: 'Replay one recorded browser operation by its history sequence number (from dsh_browser_history). Navigate/click/type are re-issued against the current page; execute re-runs its script. The replayed step is appended to history as a new entry.',
    parameters: {
      seq: { type: 'number', required: true, description: 'The history entry sequence number to replay.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { replayed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.replayed ? 'Replayed.' : 'Replay failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_replay', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.replay(session, args.seq)
      return { replayed: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_download',
    description: 'Download a URL to a local file, keeping the browser session\'s cookies and login state. Use for fetching files behind authentication or from the current page context. Available on the self-hosted browser; the desktop shell delegates downloads to the real browser UI.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to download.' },
      savePath: { type: 'string', required: true, description: 'Absolute path of the file to write. Must resolve inside the configured downloadDir (default: the system Downloads folder, localized names such as ~/下载 included); an existing file is never overwritten.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          handoff: { type: 'object', additionalProperties: true },
          remoteError: { type: 'string' },
          remoteResult: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const lines = [`Downloaded to ${value.path}.`]
        if (value.handoff !== undefined) lines.push(`Handed to ${String((value.handoff as Record<string, unknown>).tool)}: ${String((value.handoff as Record<string, unknown>).result ?? 'ok')}`)
        if (value.remoteError !== undefined) lines.push(`The local file is intact; the remote side did not take it: ${String(value.remoteError)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_download', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal)
      // Delivery is an attribute of the download: empty tool = the old behaviour, byte for byte.
      const plan = deliveryPlan(args.url as string, result.path)
      if (plan === undefined) return { path: result.path }
      let remoteValue: JsonValue | undefined
      try {
        const tools = (ctx as unknown as { get?: (name: string) => {
          execute?: (input: unknown) => Promise<unknown>
          setExecutor?: unknown
        } | undefined }).get?.('tools')
        if (tools?.execute === undefined) throw new Error('the tools service is not available on this surface')
        if (plan.tool === 'dsh_browser_download') throw new Error('the delivery tool must be a different tool from dsh_browser_download')
        exec.signal.throwIfAborted()
        const callId = 'handoff-' + globalThis.crypto.randomUUID()
        // DSH's executor service accepts raw batches. Earlier runtimes accept one parsed call.
        // Select the API before dispatch so a retry can never upload the same file twice.
        const batched = typeof tools.setExecutor === 'function'
        const answer = await tools.execute(batched ? {
          calls: [{ type: 'tool-call', id: callId, name: plan.tool, arguments: JSON.stringify(plan.args) }],
          agent: exec.agent,
          toolSet: (exec as typeof exec & { readonly toolSet?: unknown }).toolSet,
          signal: exec.signal,
        } : {
          callId,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: plan.tool,
          arguments: plan.args,
          agent: exec.agent,
          signal: exec.signal,
        })
        let outcome = answer
        let concluded = false
        if (batched) {
          const batch = answer as { results?: { callId?: string; result?: unknown }[]; additionalContexts?: unknown[]; concluded?: boolean } | null
          if (!Array.isArray(batch?.results) || batch.results.length !== 1 || batch.results[0]?.callId !== callId) {
            throw new Error('the delivery executor returned no matching tool result')
          }
          for (const context of batch.additionalContexts ?? []) {
            exec.deferContext(context as Parameters<typeof exec.deferContext>[0])
          }
          concluded = batch.concluded === true
          outcome = batch.results[0].result
        }
        const settled = outcome as { value?: JsonValue; additionalContexts?: unknown[]; concludesTurn?: boolean } | null
        remoteValue = settled?.value
        const summary = summariseToolResult(outcome)
        if (!batched) {
          for (const context of settled?.additionalContexts ?? []) {
            exec.deferContext(context as Parameters<typeof exec.deferContext>[0])
          }
          concluded = settled?.concludesTurn === true
        }
        if (concluded) exec.concludeTurn()
        return { path: result.path, handoff: { tool: plan.tool, result: summary, value: remoteValue ?? null } }
      } catch (error) {
        exec.signal.throwIfAborted()
        const reason = error instanceof Error ? error.message : String(error)
        if (plan.onFail === 'stop') throw new Error(`dsh_browser_download: saved to ${result.path} locally, but the handoff to "${plan.tool}" failed: ${reason}`)
        return {
          path: result.path,
          remoteError: plan.tool + ': ' + reason,
          ...remoteValue === undefined ? {} : { remoteResult: { tool: plan.tool, value: remoteValue } },
        }
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_session',
    description: 'Show THIS task\'s browser session: its id and open tabs. Each task (DSH session) has its own browser session, so this reflects what your task drives. The window is shared with the human and other tasks, but tab sets and history are isolated per task.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true },
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                url: { type: 'string', required: true },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Session ${value.session}\n${(value.tabs as { id: string; url: string; active: boolean }[]).map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n')}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const tabs = await browser.listTabs(session)
      const scope = browserSessionHandle(taskKey(exec), session)
      return { session: sessionWireId(scope), tabs: scopedTabs(scope, tabs).map(t => ({ id: t.id, url: t.url, active: t.active })) }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_reset_session',
    description: 'Reset THIS task\'s browser session: close it entirely so the next dsh_browser_* call starts a fresh session with one blank tab. Other tasks\' sessions are untouched. Use when a session is in a bad state or you want a clean slate.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.reset ? 'This task\'s browser session was closed; the next call starts fresh.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // closes the whole session; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_reset_session', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      await state.pendingPanelOpens.get(key)
      state.panelUrlByTask.delete(key)
      const session = state.sessionsByTask.get(key)
      if (session !== undefined) {
        try {
          await browser.close(session)
        } finally {
          // Always forget the mapping so the next call opens a fresh session,
          // even if the provider close threw (the session is half-closed).
          state.sessionsByTask.delete(key)
        }
      }
      return { reset: true }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_restrict',
    description: 'Allow only the listed browser tools; any other dsh_browser_* call is refused. Empty list or omitted lifts it. Never blocked whatever the list says — the observing tools (snapshot/a11y/content/scrape/screenshot/get_value/wait/challenge/list_tabs/session/history/visited) and restrict/reset/reset_session — so a restriction can always be read around and undone. A SOFT guardrail against stray clicks, NOT a security boundary: you can lift it with an empty list.',
    parameters: {
      allowed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allow-list of browser tool names; empty clears the restriction.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { restrictedTo: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: (value.restrictedTo as string[]).length > 0 ? `Restricted to: ${(value.restrictedTo as string[]).join(', ')}` : 'Restriction lifted.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Always allowed so the guard can be lifted.
      const allowed = args.allowed ?? []
      const unknown = allowed.filter((t: string) => !t.startsWith('dsh_browser_'))
      if (unknown.length > 0) {
        throw new Error(`dsh_browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "dsh_browser_")`)
      }
      // Empty list (or omitted) lifts this task's restriction; a non-empty list is its
      // new allow-list. Per task, not per plugin: this state object is shared by every
      // agent, so one value here used to lock every other task's browser tools.
      //
      if (allowed.length === 0) state.restrictedByTask.delete(taskKey(exec))
      else state.restrictedByTask.set(taskKey(exec), [...allowed])
      const current = state.restrictedByTask.get(taskKey(exec))
      return { restrictedTo: current === undefined ? [] : [...current] }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_auth',
    description: 'Export or restore the session\'s cookies (login state): "flush" returns a JSON cookie list, "restore" takes that list back (e.g. after the host restarted). Works on all carriers. Refused when the credential switch is off. Exported cookies are LIVE CREDENTIALS: never echo them into the conversation or logs; keep the list in a private file.',
    parameters: {
      action: { type: 'string', required: true, enum: ['flush', 'restore'], description: 'flush = export cookies; restore = import cookies.' },
      cookies: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Cookie list to restore (required when action=restore).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
          restored: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.cookies !== undefined ? `Exported ${(value.cookies as unknown[]).length} cookies — LIVE CREDENTIALS; store privately and never echo them.` : `Restored ${value.restored} cookies.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_auth', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      if (args.action === 'flush') {
        const cookies = await browser.flushAuth(session)
        return { cookies: cookies.map(c => ({ ...c })) as never }
      }
      // The description says cookies are required for restore; without this check an
      // empty call returned {restored: 0} and rendered 'Restored 0 cookies.', which
      // reads as success and would leave the caller believing the login was restored.
      if (!Array.isArray(args.cookies) || args.cookies.length === 0) {
        throw new Error('dsh_browser_auth: action "restore" needs a non-empty "cookies" array (get one from action "flush" on the same profile)')
      }
      const list = args.cookies as unknown[]
      const restored = await browser.restoreAuth(session, list as never)
      return { restored }
    },
  }))

  // ===========================================================================
  // Observation, assertion and batch work (0.5.7).
  //
  // Five capabilities were missing against the other browser plugins in this market: what the
  // console said, which responses arrived, what happened to a JavaScript dialog (an unanswered
  // `confirm()` used to hang a whole call), a way to assert a result instead of eyeballing a
  // screenshot, and a way to run several steps in one call. All of them come from one page-side
  // probe installed through `execute`, so they work identically on the self-hosted window, a driven
  // Chrome/Edge and the desktop sidebar — no host change, no bridge protocol version.
  // ===========================================================================

  /**
   * What to do with a saved file, from the settings document.
   *
   * Read here rather than threaded through the provider on purpose: delivery is a property of how
   * this deployment saves files, not of which browser carries the page, so every carrier gets it
   * for free and no seam grows a method for it.
   *
   * @param url - the downloaded address, used to pick a per-site override by host.
   * @param path - the absolute local path just written.
   * @returns the plan, or undefined when nothing is configured (the old behaviour).
   */
  function deliveryPlan(url: string, path: string): { tool: string; args: Record<string, string>; onFail: 'keep-local' | 'stop' } | undefined {
    let settings
    try { settings = settingsStore.get() } catch { return undefined }
    const delivery = settings.delivery
    if (delivery === undefined) return undefined
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { host = '' }
    const override = host === '' ? undefined : (delivery.sites[host] ?? delivery.sites['*'])
    const tool = override ?? delivery.tool
    if (typeof tool !== 'string' || tool.trim() === '') return undefined
    const name = path.split(/[\\/]/).pop() ?? path
    const size = (() => { try { return String(statSync(path).size) } catch { return '' } })()
    const args: Record<string, string> = {}
    for (const [key, value] of Object.entries(delivery.args)) {
      args[key] = String(value).split('{path}').join(path).split('{name}').join(name).split('{size}').join(size)
    }
    if (Object.keys(args).length === 0) args.file_path = path
    return { tool: tool.trim(), args, onFail: delivery.onFail }
  }

  /** Check the canonical outcome before describing a completed delivery. */
  function summariseToolResult(answer: unknown): string {
    const outcome = answer as { isError?: boolean; value?: unknown; error?: { message?: string }; content?: { text?: string }[] } | null
    if (outcome === null || typeof outcome !== 'object' || typeof outcome.isError !== 'boolean') {
      throw new Error('the delivery executor returned an invalid tool result')
    }
    if (outcome.isError) {
      throw new Error(outcome.error?.message || outcome.content?.map(block => block.text ?? '').join(' ') || 'the delivery tool failed')
    }
    if (!('value' in outcome)) throw new Error('the delivery executor returned an invalid tool result')
    const failure = deliveryFailure(outcome.value)
    if (failure !== undefined) throw new Error(failure)
    const text = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value)
    return text.length > 200 ? text.slice(0, 200) + '…' : text
  }

  /** Read explicit failure markers in common MCP structured or JSON text responses. */
  function deliveryFailure(value: unknown): string | undefined {
    const object = (candidate: unknown): Record<string, unknown> | undefined => {
      if (typeof candidate === 'string') {
        try { candidate = JSON.parse(candidate) } catch { return undefined }
      }
      return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as Record<string, unknown> : undefined
    }
    const response = object(value)
    if (response === undefined) return undefined
    const blocks = Array.isArray(response.content) ? response.content : []
    const candidates = [
      response,
      object(response.structuredContent),
      ...blocks.map(block => {
        const content = object(block)
        return content?.type === 'text' ? object(content.text) : undefined
      }),
    ]
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      if (candidate.isError !== true && candidate.ok !== false && candidate.success !== false
        && candidate.status !== 'error' && candidate.status !== 'failed') continue
      const error = object(candidate.error)
      const detail = [candidate.message, candidate.error, error?.message].find(item => typeof item === 'string' && item !== '')
      return typeof detail === 'string' ? detail : 'the delivery tool reported a failed upload'
    }
    return undefined
  }

  /** Run a script in the page and return its value as text. */
  async function pageValue(browser: NonNullable<Context['browser']>, session: BrowserSessionId, script: string, signal?: AbortSignal): Promise<string> {
    const result = await browser.execute(session, { script }, signal)
    if (!result.ok) throw new Error(`page script failed: ${result.exception}`)
    const raw = result.value
    return typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  }

  /** Fixed operations keep their inputs as data and preserve arbitrary-script permissions. */
  async function pageOperationValue(browser: NonNullable<Context['browser']>, session: BrowserSessionId, request: BrowserPageOperationRequest, signal?: AbortSignal): Promise<string> {
    const result = typeof browser.pageOperation === 'function'
      ? await browser.pageOperation(session, request, signal)
      : await browser.execute(session, { script: pageOperationScript(request) }, signal)
    if (!result.ok) throw new Error('page operation failed: ' + result.exception)
    return typeof result.value === 'string' ? result.value : JSON.stringify(result.value ?? null)
  }

  /** Install the fixed probe and report page failures immediately. */
  async function installProbe(browser: NonNullable<Context['browser']>, session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    await pageOperationValue(browser, session, { operation: 'install' }, signal)
  }

  /** One probe call, parsed. Throws when the probe is absent or the call failed. */
  async function probe<T = unknown>(
    browser: NonNullable<Context['browser']>,
    session: BrowserSessionId,
    method: BrowserProbeMethod,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const text = await pageOperationValue(browser, session, { operation: 'probe', method, args }, signal)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error(`page probe returned unreadable JSON: ${text.slice(0, 120)}`) }
    if (parsed !== null && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
      throw new Error(`page probe: ${String((parsed as Record<string, unknown>).error)}`)
    }
    return parsed as T
  }

  /**
   * A probe call that survives a navigation inside a batch.
   *
   * Submitting a form replaces the document, and the probe with it, so a later step in the same
   * batch would fail with `probe-not-installed` — measured on the first real benchmark run. One
   * reinstall and one retry is enough: a second failure is a real absence, not a stale context.
   */
  async function probeLive<T = unknown>(
    browser: NonNullable<Context['browser']>,
    session: BrowserSessionId,
    method: BrowserProbeMethod,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await probe<T>(browser, session, method, args, signal)
    } catch (error) {
      if (!/probe-not-installed|probe-method-missing/.test(String(error))) throw error
      await installProbe(browser, session, signal)
      return await probe<T>(browser, session, method, args, signal)
    }
  }

  /** Sleep. Long waits are capped by the caller, and the tool timeout still applies. */
  async function pause(ms: number): Promise<void> {
    await new Promise<void>(resolve => { setTimeout(resolve, ms) })
  }

  /** Poll until the callback returns something, or the budget runs out. */
  async function poll<T>(check: () => Promise<T | undefined>, budgetMs: number): Promise<T | undefined> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const value = await check()
      if (value !== undefined) return value
      if (Date.now() >= deadline) return undefined
      await pause(200)
    }
  }

  /**
   * One flat probe row: what a page can hand back through JSON.
   *
   * Concrete rather than `Record<string, unknown>`, because the tool output schema is a JSON value
   * and the compiler (rightly) refuses to promise that an `unknown` is one.
   */
  type ProbeRow = Record<string, string | number | boolean | null>

  /**
   * Run one `dsh_browser_check` specification against the page.
   *
   * Shared by the `check` tool and by the `{check: …}` step of `dsh_browser_do`, so a batch asserts
   * exactly what a standalone call asserts.
   */
  async function runChecks(
    browser: NonNullable<Context['browser']>,
    session: BrowserSessionId,
    spec: { readonly selector?: string; readonly text?: string; readonly url?: string; readonly js?: string },
    signal?: AbortSignal,
  ): Promise<{ pass: boolean; checks: Array<{ kind: string; expected: string; actual: string; pass: boolean }> }> {
    const checks: Array<{ kind: string; expected: string; actual: string; pass: boolean }> = []
    if (spec.selector !== undefined) {
      const found = await probeLive<{ described?: string } | null>(browser, session, 'find', [{ css: spec.selector }], signal)
      checks.push({ kind: 'selector', expected: spec.selector, actual: found === null ? 'not found' : String(found.described ?? 'found'), pass: found !== null })
    }
    if (spec.text !== undefined) {
      const present = await pageOperationValue(browser, session, { operation: 'text', text: spec.text }, signal)
      const ok = present === 'true'
      checks.push({ kind: 'text', expected: spec.text, actual: ok ? 'present' : 'absent', pass: ok })
    }
    if (spec.url !== undefined) {
      const href = await pageOperationValue(browser, session, { operation: 'url' }, signal).then(text => text.replace(/^"|"$/g, ''))
      const ok = href.includes(spec.url)
      checks.push({ kind: 'url', expected: spec.url, actual: href, pass: ok })
    }
    if (spec.js !== undefined) {
      try {
        const value = await pageValue(browser, session, `(() => { try { return JSON.stringify({ ok: !!(${spec.js}) }) } catch (error) { return JSON.stringify({ ok: false, error: String(error) }) } })()`, signal)
        const parsed = JSON.parse(value) as { ok?: boolean; error?: string }
        checks.push({ kind: 'js', expected: spec.js, actual: parsed.ok === true ? 'truthy' : (parsed.error ?? 'falsy'), pass: parsed.ok === true })
      } catch (error) {
        checks.push({ kind: 'js', expected: spec.js, actual: String(error), pass: false })
      }
    }
    return { pass: checks.length > 0 && checks.every(check => check.pass), checks }
  }

  registerSafely(defineTool({
    name: 'dsh_browser_console',
    description: 'Read what the page has logged (console.log/info/warn/error/debug), newest last, capped at 200 lines. Use it when the screen does not explain a failure: a red toast, a form that silently refuses, a page that "just does nothing". Set clear:true first when you only want what happens next. A page that logs objects shows their JSON.',
    parameters: {
      limit: { type: 'number', description: 'How many lines, newest last (default 20, max 100).' },
      filter: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
      clear: { type: 'boolean', description: 'Clear the buffer before reading.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } },
      },
      render: (_args, value) => {
        const rows = value.entries as Array<{ level?: string; text?: string }>
        if (rows.length === 0) return [{ type: 'text', text: 'No console lines yet (nothing logged since the page probe was installed).' }]
        return [{ type: 'text', text: rows.map(row => `[${String(row.level)}] ${String(row.text)}`).join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      if (args.clear === true) await probe(browser, session, 'clear', ['console'], exec.signal)
      const entries = await probe<ProbeRow[]>(browser, session, 'read', ['console', args.filter ?? '', args.limit ?? 20], exec.signal)
      return { entries }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_network',
    description: 'List the responses the page has received, newest last: method, status, type and address, for fetch, XHR and resource-timing entries. Use it when a page fills itself from the network and the screen does not say why, or to confirm a submit actually reached the server. onlyFailures keeps status 0 (blocked/aborted) and 4xx/5xx. Resource-timing rows carry no status (the browser never exposed it to the page) and show status 0.',
    parameters: {
      limit: { type: 'number', description: 'How many rows, newest last (default 20, max 100).' },
      filter: { type: 'string', description: 'Only rows whose address contains this text.' },
      onlyFailures: { type: 'boolean', description: 'Only rows with status 0, or status >= 400.' },
      clear: { type: 'boolean', description: 'Clear the buffer before reading.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } },
      },
      render: (_args, value) => {
        const rows = value.entries as ProbeRow[]
        if (rows.length === 0) return [{ type: 'text', text: 'No responses recorded yet.' }]
        return [{ type: 'text', text: rows.map(row => `${String(row.method)} ${String(row.status)} ${String(row.kind)} ${String(row.ms)}ms ${String(row.url)}`).join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      if (args.clear === true) await probe(browser, session, 'clear', ['network'], exec.signal)
      const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.filter ?? '', args.limit ?? 20], exec.signal)
      const entries = args.onlyFailures === true
        ? rows.filter(row => Number(row.status) === 0 || Number(row.status) >= 400)
        : rows
      return { entries }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_dialog',
    description: 'Report JavaScript dialogs (alert/confirm/prompt) the page raised, and choose how they are answered. Dialogs use the native browser UI by default. Setting policy "dismiss" answers alert/prompt with nothing and confirm with false, "accept" answers confirm with true and prompt with its current text. Policy "native" restores the original dialog functions. Reading preserves the current policy; changing it is an action. A dialog raised by the browser itself (beforeunload, HTTP auth) is not covered.',
    parameters: {
      policy: { type: 'string', enum: ['native', 'accept', 'dismiss'], description: 'Answer future dialogs this way.' },
      limit: { type: 'number', description: 'How many recent dialogs to return (default 10).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          policy: { type: 'string', required: true },
          dialogs: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.dialogs as ProbeRow[]
        const head = `Dialog policy: ${String(value.policy)} (${String(value.policy) === 'accept' ? 'confirm→true, prompt→its text' : 'confirm→false, prompt→null'}).`
        if (rows.length === 0) return [{ type: 'text', text: `${head} No dialogs seen yet.` }]
        return [{ type: 'text', text: [head, ...rows.map(row => `${String(row.kind)} "${String(row.message)}" → ${String(row.answered)}`)] .join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // the policy is task-wide state
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_dialog', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const policy = args.policy === undefined
        ? await probe<string>(browser, session, 'dialogStatus', [], exec.signal)
        : await probe<string>(browser, session, 'setDialogPolicy', [args.policy], exec.signal)
      const dialogs = await probe<ProbeRow[]>(browser, session, 'read', ['dialogs', '', args.limit ?? 10], exec.signal)
      return { policy, dialogs }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_wait_for_response',
    description: 'Wait until a response whose address contains `urlContains` has arrived AFTER this call started: optional status (e.g. 200, or 4xx), bounded by timeoutMs. Use it instead of sleeping before a snapshot when a click submits a form or starts a fetch — it returns as soon as the server answered, and says what arrived when it did not. This is the "did the submit reach the server" question that a screenshot cannot answer.',
    parameters: {
      urlContains: { type: 'string', required: true, description: 'Substring of the request address.' },
      status: { type: 'number', description: 'Require this exact status (a non-zero status is required to match).' },
      timeoutMs: { type: 'number', description: 'How long to wait (default 15000, capped by the tool timeout).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matched: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          entry: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const entry = value.entry as Record<string, unknown> | undefined
        if (!value.matched) return [{ type: 'text', text: `No matching response: ${String(value.reason)}` }]
        return [{ type: 'text', text: `Matched: ${String(entry?.method)} ${String(entry?.status)} ${String(entry?.url)} (${String(entry?.ms)}ms)` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const cursor = await probe<{ startedAt: number; sequence: number }>(browser, session, 'networkCursor', [], exec.signal)
      // Batched code holds back the triggering action until the cursor is captured.
      ;(exec as { armed?: () => void }).armed?.()
      const budget = Math.min(args.timeoutMs ?? 15_000, maxWaitMs)
      const found = await poll(async () => {
        const current = await probe<{ startedAt: number; sequence: number }>(browser, session, 'networkCursor', [], exec.signal)
        if (current.startedAt !== cursor.startedAt) throw new Error('the page changed while waiting for a response; start a new wait on the current page')
        const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.urlContains, 100], exec.signal)
        const fresh = rows.filter(row => Number(row.sequence) > cursor.sequence && Number(row.status) > 0)
        const exact = args.status === undefined ? fresh : fresh.filter(row => Number(row.status) === args.status)
        return exact.length > 0 ? exact[exact.length - 1] : undefined
      }, budget)
      if (found === undefined) {
        const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.urlContains, 60], exec.signal)
        const seen = rows.length === 0 ? 'nothing matched the address' : `${rows.length} older row(s) matched but none arrived after this call started`
        return { matched: false, reason: `${seen} within ${Math.round(budget / 1000)}s` }
      }
      return { matched: true, reason: 'response arrived', entry: found }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_assert',
    description: 'Assert facts about the page in one call and get a pass/fail per assertion with the evidence: a CSS selector exists, the body text contains something, the URL contains something, or a JavaScript expression is truthy. Use it to verify a step actually worked — "clicked" and "the form accepted it" are different claims — and before retrying anything that might have already taken effect.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector that must match an element.' },
      text: { type: 'string', description: 'Text that must appear in the page body.' },
      url: { type: 'string', description: 'Substring the URL must contain.' },
      js: { type: 'string', description: 'Expression that must be truthy, e.g. document.querySelector("#ok") !== null.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pass: { type: 'boolean', required: true },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.checks as ProbeRow[]
        const lines = rows.map(row => `${row.pass === true ? 'PASS' : 'FAIL'} ${String(row.kind)}: ${String(row.expected)} → ${String(row.actual)}`)
        return [{ type: 'text', text: `${value.pass === true ? 'All checks passed.' : 'A check failed.'}\n${lines.join('\n')}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const spec = {
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.text !== undefined ? { text: args.text } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        ...args.js !== undefined ? { js: args.js } : {},
      }
      if (Object.keys(spec).length === 0) throw new Error('dsh_browser_assert: give at least one of selector, text, url or js')
      return await runChecks(browser, session, spec, exec.signal)
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_drag',
    description: 'Drag from one viewport point to another using trusted browser pointer input. Coordinates are CSS pixels from the top-left of the current viewport. Use for sliders, sortable lists, HTML drag-and-drop and canvas drawing. Check the resulting control value or page state after the gesture.',
    parameters: {
      fromX: { type: 'number', required: true, description: 'Start x in viewport CSS pixels.' },
      fromY: { type: 'number', required: true, description: 'Start y in viewport CSS pixels.' },
      toX: { type: 'number', required: true, description: 'End x.' },
      toY: { type: 'number', required: true, description: 'End y.' },
      steps: { type: 'number', description: 'Intermediate moves (default 12, max 60); more steps make a slider follow the path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === true ? 'Dragged.' : `Drag failed: ${String(value.reason)}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // a pointer gesture; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_drag', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const text = await pageOperationValue(browser, session, {
        operation: 'drag',
        from: { x: args.fromX, y: args.fromY },
        to: { x: args.toX, y: args.toY },
        steps: args.steps ?? 12,
      }, exec.signal)
      const parsed = JSON.parse(text) as { ok?: boolean; reason?: string; moved?: number }
      return { ok: parsed.ok === true, reason: parsed.ok === true ? `moved ${String(parsed.moved)} steps` : String(parsed.reason ?? 'unknown') }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_doctor',
    description: 'Report the state of this task\'s browser: page URL, which tools the task restricted away, whether the page probe is installed, and what it has recorded (console lines, responses, dialogs, and how "settled" the page looks). Use it when something behaves oddly and the cause is not visible in the page — before guessing, or before telling the user the browser is broken.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.report) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const task = taskKey(exec)
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const url = await pageOperationValue(browser, session, { operation: 'url' }, exec.signal).then(text => text.replace(/^"|"$/g, ''))
      const settle = await probe<{ pending?: number; quietMs?: number; readyState?: string }>(browser, session, 'settle', [], exec.signal)
      const consoleRows = await probe<unknown[]>(browser, session, 'read', ['console', '', 100], exec.signal)
      const networkRows = await probe<unknown[]>(browser, session, 'read', ['network', '', 100], exec.signal)
      const dialogRows = await probe<ProbeRow[]>(browser, session, 'read', ['dialogs', '', 5], exec.signal)
      const restricted = state.restrictedByTask.get(task)
      const lines = [
        `session ${session}`,
        `url ${url || '(unknown)'}`,
        `page ${String(settle?.readyState ?? '?')}, ${String(settle?.pending ?? 0)} request(s) in flight, quiet for ${String(settle?.quietMs ?? 0)}ms`,
        `probe installed (console ${consoleRows.length}/100, network ${networkRows.length}/100, dialogs ${dialogRows.length}/5)`,
        restricted === undefined ? 'restricted: no (this task restricted nothing)' : `restricted: ${restricted.length === 0 ? 'everything' : restricted.join(', ')}`,
        state.configRestrictedTo === undefined ? 'deployment allow-list: none' : `deployment allow-list: ${state.configRestrictedTo.join(', ')}`,
      ]
      return { report: lines.join('\n') }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_help',
    description: 'Look up how to use this browser: a short topic index (locate, wait, batch, dialogs, network, verify, recovery, limits) or one topic\'s text. Use it instead of guessing when a call failed for a reason the error message explains only briefly.',
    parameters: {
      topic: { type: 'string', description: 'One topic name; omit for the index.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const topics: Record<string, string> = {
        locate: 'Prefer dsh_browser_a11y (roles, names, states) or dsh_browser_snapshot (numbered elements), then click with {target:{by:"text"|css|xpath, value}}. Elements carry a stable CSS selector, so a click re-resolves the element instead of trusting an index that a re-render invalidates.',
        wait: 'dsh_browser_wait waits for load + an optional URL/selector. dsh_browser_wait_for_response waits for a server answer (that is the "did it submit" wait). dsh_browser_console/network then explain what the page did.',
        batch: 'dsh_browser_do runs several steps in one call: open/tap/field/type/key/scroll/sleep_ms/wait_text/wait_gone/wait_url/wait_idle/eval/check. It stops at the first step that cannot proceed and reports which one; a tap whose target is covered by a cookie banner dismisses the banner first.',
        dialogs: 'JavaScript dialogs are answered automatically (default: dismiss). dsh_browser_dialog reports them and can switch to "accept". A dialog from the browser itself (beforeunload, HTTP auth) is not covered — expect a stalled call there and reload.',
        network: 'dsh_browser_network lists fetch/XHR/resource rows. Status 0 means the page never saw a status (aborted, blocked, or a resource-timing row). Only fetch/XHR rows carry a real status.',
        verify: 'dsh_browser_assert asserts selector/text/url/js and returns evidence per assertion. Prefer it over reading a screenshot: "clicked" and "the form accepted it" are different claims, and a retry of an unverified submit can double it.',
        recovery: 'dsh_browser_reset_session closes this task\'s browser session without touching others. dsh_browser_refresh reloads the page. If a carrier was lost, the page context is gone: re-read the page before continuing, and never re-submit something whose result you did not verify.',
        limits: 'There is no CDP escape hatch and no network interception: the probe sees what the page sees. Downloads go through dsh_browser_download and a directory admission gate. Executing page JavaScript is a settings switch the model cannot lift.',
        deliver: 'The browser saves a file and returns an absolute path; sending it to Feishu drive, Baidu Netdisk or any MCP-connected storage is a separate tool call with that path. Report where it sits locally AND what the upload tool answered, never just one. If the upload tool is missing or fails, keep the local file and say so — do not retry somewhere else silently.',
      }
      if (args.topic === undefined) {
        return { text: `Topics: ${Object.keys(topics).join(', ')}\nAsk for one with topic=<name>.` }
      }
      const text = topics[args.topic]
      if (text === undefined) throw new Error(`dsh_browser_help: unknown topic "${args.topic}" (${Object.keys(topics).join(', ')})`)
      return { text }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_do',
    description: 'Run several steps in ONE call and report one compact result: "click search, type a query, press Enter, wait for results" is one call instead of five. Steps run in order and stop at the first that cannot proceed. Each step is an object with exactly one key: open {url} | tap {target} | field {target, text} | type {text} | key {key} | scroll {deltaY} | sleep_ms {ms} | wait_text {text} | wait_gone {text} | wait_url {url} | wait_idle {} | eval {script} | check {selector|text|url|js}. A tap whose target is covered by a cookie banner or modal dismisses it first. Waits know when the page has settled and return as soon as the condition holds.',
    parameters: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Steps, in order (max 40).' },
      timeoutMs: { type: 'number', description: 'Budget for the whole batch (default 60000, capped by the tool timeout).' },
      autoDismiss: { type: 'boolean', description: 'Clear a covering banner before a tap (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          completed: { type: 'number', required: true },
          total: { type: 'number', required: true },
          ok: { type: 'boolean', required: true },
          stoppedAt: { type: 'number' },
          reason: { type: 'string' },
          sideEffectMayHaveHappened: { type: 'boolean' },
          log: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.log as ProbeRow[]
        const head = value.ok === true
          ? `${String(value.completed)}/${String(value.total)} steps done.`
          : `Stopped at step ${String(value.stoppedAt)} (${String(value.completed)}/${String(value.total)} done): ${String(value.reason)}`
        const warning = value.ok === false && value.sideEffectMayHaveHappened === true
          ? '\nA step that can change the page already ran: the site may have acted on it. Read the site\'s own record before retrying — do not repeat it on the assumption that it failed.'
          : ''
        return [{ type: 'text', text: [head + warning, ...rows.map(row => `  ${String(row.index)} ${String(row.kind)}: ${String(row.detail)}`)].join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // drives the page; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_do', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const steps = Array.isArray(args.steps) ? args.steps as ProbeRow[] : []
      if (steps.length === 0) throw new Error('dsh_browser_do: "steps" must be a non-empty array')
      if (steps.length > 40) throw new Error('dsh_browser_do: at most 40 steps per call — split the work')
      await installProbe(browser, session, exec.signal)
      const autoDismiss = args.autoDismiss !== false
      const budget = Math.min(args.timeoutMs ?? timeoutMs, maxWaitMs)
      const deadline = Date.now() + budget
      const log: Array<{ index: number; kind: string; detail: string }> = []
      // Set once a step that can change server state has run. A failure after that point must not
      // read like a failure before it: measured on the first real benchmark run, where a batch died
      // after the form had already been submitted and the message said nothing about it.
      let dispatched = false
      const dispatchable = new Set(['tap', 'key', 'eval'])
      const kinds = ['open', 'tap', 'field', 'type', 'key', 'scroll', 'sleep_ms', 'wait_text', 'wait_gone', 'wait_url', 'wait_idle', 'eval', 'check']

      /** Resolve a target: a string is visible text; an object passes through. */
      const asTarget = (value: unknown): { by: 'css' | 'text' | 'xpath'; value: string } | undefined => {
        if (typeof value === 'string' && value !== '') return { by: 'text', value }
        if (value !== null && typeof value === 'object') {
          const raw = value as { by?: unknown; value?: unknown }
          if (typeof raw.value === 'string' && raw.value !== '') {
            const by = raw.by === 'css' || raw.by === 'xpath' || raw.by === 'text' ? raw.by : 'text'
            return { by, value: raw.value }
          }
        }
        return undefined
      }

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] ?? {}
        const keys = Object.keys(step).filter(key => kinds.includes(key))
        if (keys.length !== 1) {
          return { ok: false, completed: index, total: steps.length, stoppedAt: index + 1, reason: `step ${index + 1} must have exactly one of: ${kinds.join(', ')}`, log }
        }
        const kind = keys[0] as string
        const value = step[kind]
        if (Date.now() > deadline) {
          return { ok: false, completed: index, total: steps.length, stoppedAt: index + 1, reason: `budget of ${Math.round(budget / 1000)}s exhausted`, log }
        }
        try {
          let detail = 'ok'
          if (kind === 'open') {
            const url = typeof value === 'string' ? value : (value as { url?: unknown })?.url
            if (typeof url !== 'string') throw new Error('open needs a URL string or {url}')
            await browser.openUrl(session, { url }, exec.signal)
            detail = url
          } else if (kind === 'tap') {
            const target = asTarget((value as { target?: unknown })?.target ?? value)
            if (target === undefined) throw new Error('tap needs a target (text, or {by, value})')
            if (autoDismiss) {
              const rect = await probeLive<{ x?: number; y?: number; described?: string } | null>(browser, session, 'find', [{ [target.by]: target.value }], exec.signal)
              if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
                const cover = await probeLive<{ covers?: string | null; dismiss?: { label?: string; x?: number; y?: number } | null }>(browser, session, 'overlayAt', [rect.x, rect.y], exec.signal)
                if (cover?.dismiss && typeof cover.dismiss.x === 'number' && typeof cover.dismiss.y === 'number') {
                  await browser.click(session, { x: cover.dismiss.x, y: cover.dismiss.y }, exec.signal)
                  detail = `dismissed "${String(cover.dismiss.label)}" first`
                  await pause(150)
                } else if (cover?.covers !== null && cover?.covers !== undefined && cover.covers !== rect.described) {
                  // Measured on the fixture's human gate: a hidden form left the tap hitting `<html>`,
                  // the step reported "ok", and nothing was submitted. A click that cannot land is a
                  // FAILURE, not a note — a silent no-op is the worst result this tool can return.
                  throw new Error(`the target is not reachable: ${String(cover.covers)} is at that point, not ${String(rect.described)} (hidden, or covered by an overlay that cannot be dismissed)`)
                }
              }
            }
            await browser.click(session, { target }, exec.signal)
          } else if (kind === 'field') {
            const spec = value as { target?: unknown; text?: unknown }
            const target = asTarget(spec?.target)
            if (target === undefined || typeof spec?.text !== 'string') throw new Error('field needs {target, text}')
            await browser.setValue(session, { target, value: spec.text }, exec.signal)
            detail = `${target.value} ← ${spec.text.slice(0, 40)}`
          } else if (kind === 'type') {
            const text = typeof value === 'string' ? value : (value as { text?: unknown })?.text
            if (typeof text !== 'string') throw new Error('type needs a text string or {text}')
            await browser.type(session, { text }, exec.signal)
            detail = text.slice(0, 40)
          } else if (kind === 'key') {
            const key = typeof value === 'string' ? value : (value as { key?: unknown })?.key
            if (typeof key !== 'string') throw new Error('key needs a key name or {key}')
            await browser.key(session, { key: key as never }, exec.signal)
            detail = key
          } else if (kind === 'scroll') {
            const deltaY = typeof value === 'number' ? value : Number((value as { deltaY?: unknown })?.deltaY ?? Number.NaN)
            if (!Number.isFinite(deltaY)) throw new Error('scroll needs a number or {deltaY}')
            await browser.scroll(session, { deltaY }, exec.signal)
            detail = String(deltaY)
          } else if (kind === 'sleep_ms') {
            const requestedMs = typeof value === 'number' ? value : (value as { ms?: unknown })?.ms
            if (typeof requestedMs !== 'number' || !Number.isFinite(requestedMs) || requestedMs < 0) throw new Error('sleep_ms needs a non-negative number or {ms}')
            const ms = Math.min(requestedMs, 10_000)
            await pause(ms)
            detail = `${ms}ms`
          } else if (kind === 'wait_text' || kind === 'wait_gone') {
            const want = typeof value === 'string' ? value : (value as { text?: unknown })?.text
            if (typeof want !== 'string') throw new Error('wait_text/wait_gone need text or {text}')
            const found = await poll(async () => {
              const present = (await pageOperationValue(browser, session, { operation: 'text', text: want }, exec.signal)) === 'true'
              return (kind === 'wait_text' ? present : !present) ? true : undefined
            }, Math.max(1_000, Math.min(deadline - Date.now(), 30_000)))
            if (found === undefined) throw new Error(`timed out waiting for "${want}" to be ${kind === 'wait_text' ? 'present' : 'gone'}`)
            detail = want
          } else if (kind === 'wait_url') {
            const want = typeof value === 'string' ? value : (value as { url?: unknown })?.url
            if (typeof want !== 'string') throw new Error('wait_url needs a URL fragment or {url}')
            const budget = Math.max(1_000, Math.min(deadline - Date.now(), 30_000))
            const hit = await poll(async () => {
              const href = (await pageOperationValue(browser, session, { operation: 'url' }, exec.signal)).replace(/^"|"$/g, '')
              return href.includes(want) ? href : undefined
            }, budget)
            if (hit === undefined) throw new Error(`timed out waiting for the URL to contain "${want}"`)
            detail = hit
          } else if (kind === 'wait_idle') {
            const idle = await poll(async () => {
              const settle = await probeLive<{ pending?: number; quietMs?: number; readyState?: string }>(browser, session, 'settle', [], exec.signal)
              const quiet = Number(settle?.quietMs ?? 0)
              return Number(settle?.pending ?? 0) === 0 && quiet >= 300 ? settle : undefined
            }, Math.max(1_000, Math.min(deadline - Date.now(), 30_000)))
            if (idle === undefined) throw new Error('timed out waiting for the page to go quiet')
            detail = `quiet for ${String(idle.quietMs)}ms`
          } else if (kind === 'eval') {
            const script = typeof value === 'string' ? value : (value as { script?: unknown })?.script
            if (typeof script !== 'string') throw new Error('eval needs a script string or {script}')
            const text = await pageValue(browser, session, script, exec.signal)
            detail = text.slice(0, 80)
          } else if (kind === 'check') {
            const result = await runChecks(browser, session, value as { selector?: string; text?: string; url?: string; js?: string }, exec.signal)
            if (!result.pass) {
              const failed = result.checks.filter(check => !check.pass).map(check => `${check.kind}: ${check.expected} → ${check.actual}`)
              throw new Error(`check failed (${failed.join('; ')})`)
            }
            detail = `${result.checks.length} check(s) passed`
          }
          if (dispatchable.has(kind)) dispatched = true
          log.push({ index: index + 1, kind, detail })
        } catch (error) {
          return {
            ok: false,
            completed: index,
            total: steps.length,
            stoppedAt: index + 1,
            reason: error instanceof Error ? error.message : String(error),
            sideEffectMayHaveHappened: dispatched,
            log: [...log, { index: index + 1, kind, detail: `failed: ${error instanceof Error ? error.message : String(error)}` }],
          }
        }
      }
      return { ok: true, completed: steps.length, total: steps.length, log }
    },
  }))
  registerSafely(defineTool({
    name: 'dsh_browser_upload',
    description: 'Put a local file into a file input on the page (attachment, avatar, import form). The path must be a file INSIDE the current workspace, and only the bytes of that one file are read. The file is rebuilt in the page as a File and attached through a DataTransfer, so a form that reads input.files and a drop handler both see it; the change event is fired for you. Oversized files are refused rather than truncated.',
    parameters: {
      target: { type: 'object', required: true, additionalProperties: true, description: 'The input: {by: "css"|"text"|"xpath", value} — a text target is resolved to the element at that point and then to a nested input[type=file].' },
      path: { type: 'string', required: true, description: 'Absolute path of a file inside the workspace.' },
      mime: { type: 'string', description: 'MIME type (default guessed from the extension, else application/octet-stream).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string' },
          size: { type: 'number' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === true ? `Attached ${String(value.name)} (${String(value.size)} bytes).` : `Upload failed: ${String(value.reason)}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_upload', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: unknown; value?: unknown }
      const by = target?.by === 'css' || target?.by === 'xpath' || target?.by === 'text' ? target.by : 'css'
      if (typeof target?.value !== 'string' || target.value === '') throw new Error('dsh_browser_upload: target.value is required')
      const { open, realpath, stat } = await import('node:fs/promises')
      const { resolve, relative, isAbsolute, extname, basename, sep } = await import('node:path')
      if (!isAbsolute(args.path)) throw new Error('dsh_browser_upload: path must be absolute')
      const agent = agentOf(exec) as (ExecAgent & { session?: { header?: { cwd?: string } } }) | undefined
      const directory = (agent?.ctx?.get?.('workingDirectory') ?? ctx.get('workingDirectory')) as {
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>
      } | undefined
      const workspacePath = directory && agent
        ? await directory.ensure(agent, exec.signal)
        : agent?.session?.header?.cwd ?? process.cwd()
      if (!isAbsolute(workspacePath)) throw new Error('dsh_browser_upload: the task workspace must be absolute')
      const workspace = await realpath(workspacePath)
      const resolved = await realpath(resolve(args.path))
      const offset = relative(workspace, resolved)
      if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) {
        throw new Error('dsh_browser_upload: refusing to read a file outside the task workspace')
      }
      const expected = await stat(resolved)
      const LIMIT = 20 * 1024 * 1024
      if (!expected.isFile()) throw new Error('dsh_browser_upload: path must name a regular file')
      if (expected.size > LIMIT) throw new Error('dsh_browser_upload: file is over the 20 MB limit')
      const file = await open(resolved, 'r')
      let bytes: Buffer
      try {
        const opened = await file.stat()
        if (opened.dev !== expected.dev || opened.ino !== expected.ino
          || opened.size !== expected.size || !opened.isFile()
          || await realpath(resolve(args.path)) !== resolved) {
          throw new Error('dsh_browser_upload: file changed while opening; retry')
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: LIMIT, signal: exec.signal })) {
          length += chunk.length
          if (length > LIMIT) throw new Error('dsh_browser_upload: file grew over the 20 MB limit')
          chunks.push(chunk as Buffer)
        }
        const after = await file.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size
          || await realpath(resolve(args.path)) !== resolved) {
          throw new Error('dsh_browser_upload: file changed while reading; retry')
        }
        bytes = Buffer.concat(chunks, length)
      } finally {
        await file.close()
      }
      const guess: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip' }
      const mime = args.mime ?? guess[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
      await installProbe(browser, session, exec.signal)
      const text = await pageOperationValue(browser, session, {
        operation: 'upload',
        target: { by, value: target.value },
        file: { name: basename(resolved), mime, base64: bytes.toString('base64') },
      }, exec.signal)
      const parsed = JSON.parse(text) as { ok?: boolean; reason?: string; name?: string; size?: number }
      return parsed.ok === true
        ? { ok: true, name: String(parsed.name ?? ''), size: Number(parsed.size ?? 0) }
        : { ok: false, reason: String(parsed.reason ?? 'unknown') }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_hover',
    description: 'Scroll an element into view and move the browser pointer to its centre. Supports CSS hover styles and JavaScript mouseover handlers. Use before reading or clicking a hover menu.',
    parameters: {
      target: { type: 'object', required: true, additionalProperties: true, description: 'The element: {by: "css"|"text"|"xpath", value}.' },
      settleMs: { type: 'number', description: 'How long to let the menu appear before returning (default 150).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hovered: { type: 'boolean', required: true }, at: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => [{ type: 'text', text: value.hovered === true ? 'Pointer moved over the element.' : 'No element at that target.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_hover', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: unknown; value?: unknown }
      const by = target?.by === 'css' || target?.by === 'xpath' || target?.by === 'text' ? target.by : 'css'
      if (typeof target?.value !== 'string' || target.value === '') throw new Error('dsh_browser_hover: target.value is required')
      await installProbe(browser, session, exec.signal)
      const where = await probe<{ x?: number; y?: number; described?: string } | null>(browser, session, 'find', [{ [by]: target.value }, true], exec.signal)
      if (!where || typeof where.x !== 'number' || typeof where.y !== 'number') return { hovered: false, at: {} as ProbeRow }
      const fired = await probe<boolean>(browser, session, 'hoverAt', [where.x, where.y], exec.signal)
      await pause(Math.min(args.settleMs ?? 150, 2_000))
      const at: ProbeRow = { x: where.x, y: where.y, described: String(where.described ?? '') }
      return { hovered: fired === true, at }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_find',
    description: 'Find text on the page (the Ctrl+F equivalent) and get its position, so you can scroll to it or click near it without reading the whole page first. Returns up to 5 hits (all:true for up to 50), each with the surrounding snippet and the viewport point. Text inside shadow roots and iframes is not searched.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to look for (case-insensitive).' },
      all: { type: 'boolean', description: 'Return up to 50 hits instead of 5.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, hits: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } } },
      render: (_args, value) => {
        const hits = value.hits as ProbeRow[]
        if (hits.length === 0) return [{ type: 'text', text: 'Not found on the page.' }]
        return [{ type: 'text', text: [`${hits.length} hit(s):`, ...hits.map((hit, index) => `  ${index + 1}. ${String(hit.text)} @ ${String(hit.x)},${String(hit.y)}`)] .join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const hits = await probe<ProbeRow[]>(browser, session, 'findText', [args.text, args.all === true], exec.signal)
      return { count: hits.length, hits }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_state',
    description: 'One compact answer to "what is on screen": URL, title, load state, requests still in flight and how long the page has been quiet, plus the counts of inputs/buttons/links, scroll position, current selection and the first 400 characters of visible text. Use it before a full snapshot when you only need to know where you are, and after an action to see whether the page moved at all.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'object', additionalProperties: true, required: true } },
      },
      render: (_args, value) => {
        const row = value.summary as ProbeRow
        return [{ type: 'text', text: [
          `${String(row.url)}`,
          `${String(row.title)}`,
          `${String(row.readyState)}, ${String(row.pending)} in flight, quiet ${String(row.quietMs)}ms`,
          `${String(row.inputs)} input(s), ${String(row.buttons)} button(s), ${String(row.links)} link(s), scroll ${String(row.scrollY)}`,
          row.selection ? `selection: ${String(row.selection)}` : 'no selection',
          String(row.text ?? ''),
        ].join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const session = await ensureSession(browser, state, key, agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const summary = await probe<ProbeRow>(browser, session, 'summary', [], exec.signal)
      return { summary }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_reference_capture',
    description: 'Capture what the human has selected in the shared-browser page as a durable reference, so it can be quoted and found again later. The reference keeps the selected text with enough surrounding context to relocate it, any images selected with their real bytes, and any table as a structural snapshot. References are already displayed as interactive capsules for source navigation. Do not repeat reference URIs, source URLs, markers, or source/citation links in the reply. Re-capturing the same region creates a NEW reference, because a stored reference is an immutable snapshot.',
    parameters: {
      allowPartial: { type: 'boolean', description: 'Commit the fragments that succeeded when another fragment failed (default false: a group with a broken image or oversized table is refused as a whole).' },
      tableSelector: { type: 'string', description: 'Capture this table whole (CSS selector) even when the selection does not touch it.' },
      excerptText: { type: 'string', description: 'With no live selection, register the first occurrence of this exact page text as an agent excerpt. Two occurrences make it ambiguous and are refused.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          referenceId: { type: 'string' },
          pageUrl: { type: 'string' },
          title: { type: 'string' },
          parts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                partId: { type: 'string', required: true },
                type: { type: 'string', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
          failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          const reasons = value.failures.map(failure => `${failure.kind}: ${failure.reason}`).join('; ')
          return [{ type: 'text', text: `Nothing was captured. ${reasons}` }]
        }
        const lines = [
          `Reference ${value.referenceId} captured from ${value.title !== undefined && value.title !== '' ? value.title : value.pageUrl}.`,
          'The reference capsule provides source navigation. Do not repeat its URI, source URL, marker, or a source/citation link in the reply.',
          ...value.parts.map(part => `  ${part.partId} (${part.type}): ${part.preview}`),
        ]
        if (value.failures.length > 0) lines.push(`(${value.failures.length} fragment(s) failed and were left out: ${value.failures.map(failure => failure.reason).join('; ')})`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const outcome = await references().capture({
        // The DSH session owns the reference; the provider session holds the page. They are
        // different ids, and reveal needs the second one even after the first is long gone.
        sessionId: taskKey(exec),
        browserSessionId: session,
        origin: args.excerptText !== undefined ? 'agent-excerpt' : 'user-selection',
        entry: 'agent-tool',
        carrier: state.panelUrlByTask.has(taskKey(exec)) ? 'sidebar' : referenceCarrier(),
        ...args.allowPartial !== undefined ? { allowPartial: args.allowPartial } : {},
        ...args.tableSelector !== undefined ? { tableSelector: args.tableSelector } : {},
        ...args.excerptText !== undefined ? { excerptText: args.excerptText } : {},
      }, exec.signal)
      const failures = outcome.failures.map(failure => ({ kind: failure.kind, reason: failure.reason }))
      if (outcome.reference === undefined) return { ok: false, parts: [], failures }
      const summary = summarizeReference(outcome.reference)
      return {
        ok: true,
        referenceId: summary.referenceId,
        pageUrl: summary.pageUrl,
        title: summary.title,
        // The summary's arrays are readonly; the schema declares a mutable array,
        // so the parts are projected into plain objects rather than cast away.
        parts: summary.parts.map(part => ({ partId: part.partId, type: part.type, preview: part.preview })),
        failures,
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_reference_reveal',
    description: 'Return to a stored browser reference: select the browser session that captured it, verify the page is still the same one, then scroll to and highlight the part. Without partId the reference\'s first part is located; pass a partId to locate one specific fragment. A result status of page-mismatch means the session is showing another page (open the stored pageUrl first); ambiguous means several candidates matched equally and the exact one cannot be chosen; session-unavailable means the browser that captured it is gone.',
    parameters: {
      referenceId: { type: 'string', required: true, description: 'The reference id, with or without the dsh-browser-ref: prefix.' },
      partId: { type: 'string', description: 'Locate this fragment instead of the whole reference\'s first part.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          pageUrl: { type: 'string', required: true },
          currentUrl: { type: 'string' },
          note: { type: 'string' },
          parts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                partId: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
                matches: { type: 'number' },
                collapsed: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const head = value.status === 'revealed'
          ? 'Located the reference in the page.'
          : `Could not locate the reference: ${value.status}${value.note !== undefined ? ` — ${value.note}` : ''}`
        const lines = [head, ...value.parts.map(part => `  ${part.partId} (${part.type}): ${part.status}${part.matches !== undefined ? `, ${part.matches} match(es)` : ''}${part.collapsed === true ? ', whitespace-collapsed' : ''}${part.note !== undefined ? ` — ${part.note}` : ''}`)]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // The documented citation form is `dsh-browser-ref:<referenceId>/<partId?>`; accept it
      // whole so a model can paste what it wrote instead of splitting the id by hand.
      let referenceId = args.referenceId.startsWith('dsh-browser-ref:') ? args.referenceId.slice('dsh-browser-ref:'.length) : args.referenceId
      let partId = args.partId
      const slash = referenceId.indexOf('/')
      if (slash !== -1) {
        if (partId === undefined) partId = referenceId.slice(slash + 1)
        referenceId = referenceId.slice(0, slash)
      }
      const outcome = await references().reveal(referenceId, {
        ownerSessionId: taskKey(exec),
        ...partId !== undefined && partId !== '' ? { partId } : {},
      }, exec.signal)
      return {
        status: outcome.status,
        pageUrl: outcome.pageUrl,
        ...outcome.currentUrl !== undefined ? { currentUrl: outcome.currentUrl } : {},
        ...outcome.note !== undefined ? { note: outcome.note } : {},
        parts: outcome.parts.map(part => ({
          partId: part.partId,
          type: part.type,
          status: part.status,
          ...part.matches !== undefined ? { matches: part.matches } : {},
          ...part.collapsed !== undefined ? { collapsed: part.collapsed } : {},
          ...part.note !== undefined ? { note: part.note } : {},
        })),
      }
    },
  }))

  registerSafely(defineTool({
    name: 'dsh_browser_reference_list',
    description: 'List the browser references stored for this task, newest first: id, page, capture time, and one preview line per fragment. Use it to identify a reference from earlier in the conversation. Source navigation is provided by reference capsules; do not repeat reference URIs, source URLs, markers, or source/citation links in the reply.',
    parameters: {
      limit: { type: 'number', description: 'Most references to return (default 20, maximum 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          references: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                referenceId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                pageUrl: { type: 'string', required: true },
                capturedAt: { type: 'string', required: true },
                carrier: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                entry: { type: 'string', required: true },
                partCount: { type: 'number', required: true },
                parts: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      partId: { type: 'string', required: true },
                      type: { type: 'string', required: true },
                      preview: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.references.length === 0) return [{ type: 'text', text: 'No browser references are stored for this task.' }]
        return [{
          type: 'text',
          text: value.references.map(reference => [
            `Reference ${reference.referenceId} — ${reference.title !== '' ? reference.title : reference.pageUrl} (${reference.capturedAt}); source navigation is in its capsule, not a reply link.`,
            ...reference.parts.map(part => `  ${part.partId} (${part.type}): ${part.preview}`),
          ].join('\n')).join('\n\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const key = taskKey(exec)
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100)
      // Always scoped: with no agent the key is `default`, and an unfiltered read
      // would hand this task every conversation's references.
      const stored = references().list({ sessionId: key, limit })
      return {
        references: stored.slice().reverse().map(reference => {
          const summary = summarizeReference(reference)
          return {
            referenceId: summary.referenceId,
            title: summary.title,
            pageUrl: summary.pageUrl,
            capturedAt: summary.capturedAt,
            carrier: summary.carrier,
            origin: summary.origin,
            entry: summary.entry,
            partCount: summary.partCount,
            parts: summary.parts.map(part => ({ partId: part.partId, type: part.type, preview: part.preview })),
          }
        }),
      }
    },
  }))

  // Under DSH's PTC executor run_code already batches every tool, so the code tool steps aside.
  const ptcMode = (): boolean => {
    try { return (ctx as { get?: (name: string) => unknown }).get?.('ptcRuntime') !== undefined } catch { return false }
  }
  if (surface !== 'tools') {
    try {
      const code = createCodeTool(catalog)
      // Registration options (`when`) arrived with DSH 0.2.2; older registries ignore them.
      // On the code surface it is the only browser tool, so it stays even under PTC.
      ;(ctx.tools.register as (tool: unknown, options?: { when: () => boolean }) => unknown)(code.tool, surface === 'core' ? { when: () => !ptcMode() } : undefined)
      ctx.effect(() => code.dispose)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-builtin-browser: could not register ${CODE_TOOL} (${String(error)}).`)
    }
  }
  if (surface === 'core') {
    const grouped = new Set(Object.values(TOOL_GROUPS).flat())
    const members = (group: string): string[] => group === 'more'
      ? [...catalog.keys()].filter(name => !CORE_TOOLS.has(name) && !grouped.has(name)).sort()
      : (TOOL_GROUPS[group] ?? []).filter(name => catalog.has(name))
    try {
      const loader = defineTool({
        name: LOAD_TOOL,
        description: `Load more browser tools by group; they stay available for the rest of the run. Groups: ${Object.entries(TOOL_GROUPS).map(([group, names]) => `${group} (${group === 'more' ? 'every other browser tool' : names.map(name => name.slice('dsh_browser_'.length)).join(', ')})`).join('; ')}. dsh_browser_code can already call every tool without loading it.`,
        parameters: {
          groups: { type: 'array', items: { type: 'string', enum: Object.keys(TOOL_GROUPS) }, required: true, description: 'Groups to load.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            loaded: { type: 'array', items: { type: 'string' }, required: true },
            available: { type: 'array', items: { type: 'string' }, required: true },
          } },
          render: (_args, value) => [{ type: 'text', text: value.loaded.length > 0 ? `Loaded: ${value.loaded.join(', ')}.` : `Already loaded: ${value.available.join(', ')}.` }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const groups = Array.isArray(args.groups) ? args.groups.map(String) : []
          const unknown = groups.filter(group => !(group in TOOL_GROUPS))
          if (groups.length === 0 || unknown.length > 0) throw new Error(`unknown tool group(s): ${unknown.join(', ') || '(none given)'}; groups are ${Object.keys(TOOL_GROUPS).join(', ')}`)
          const names = [...new Set(groups.flatMap(members))]
          const fresh: string[] = []
          for (const name of names) {
            const definition = catalog.get(name)
            if (definition === undefined || loaded.has(name)) continue
            ctx.tools.register(definition as unknown as ReturnType<typeof defineTool>)
            loaded.add(name)
            fresh.push(name)
          }
          return { loaded: fresh, available: names }
        },
      })
      ctx.tools.register(loader)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-builtin-browser: could not register ${LOAD_TOOL} (${String(error)}).`)
    }
  }
}

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
