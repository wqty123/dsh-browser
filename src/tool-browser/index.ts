/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: each
 * calling task (a DSH session) gets its own browser session — the first
 * `browser_open` (or any tool when no session exists) opens it, and later
 * tools in the same task reuse it. Concurrent tasks therefore never fight
 * over tabs, history, or navigation state.
 * @module dsh-browser/tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BrowserSessionId } from '../browser/types.js'

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
   * `configRestrictedTo`. One set by `browser_restrict` is a decision by one task about
   * its own work, so it is keyed by task — a single shared value let one task lock the
   * browser tools of every other task, which is not what any caller asks for. Sessions
   * beside it were already keyed this way; this was not.
   */
  configRestrictedTo: readonly string[] | undefined
  restrictedByTask: Map<string, readonly string[]>
}

function createState(): ToolBrowserState {
  return { sessionsByTask: new Map(), pendingOpens: new Map(), configRestrictedTo: undefined, restrictedByTask: new Map() }
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
 * blind it or trap it, and the tool descriptions promise as much. browser_restrict
 * is in here so a task that restricted everything can still lift it.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Tools that only observe.
  'browser_snapshot', 'browser_a11y', 'browser_content', 'browser_scrape',
  'browser_screenshot', 'browser_get_value', 'browser_wait', 'browser_challenge',
  'browser_list_tabs', 'browser_session', 'browser_history', 'browser_visited',
  // browser_auth reads cookies out of the browser: an observation, and one the
  // credentials switch gates on its own (see credentials.allowRead in the settings).
  // browser_auth is deliberately NOT here. It reads cookies on "flush" but WRITES them on
  // "restore", to arbitrary domains, which is an action like any other — exempting the tool
  // would let a task that restricted its own actions rewrite the shared browser's logins.
  //
  // Getting out of a bad state, or lifting the restriction itself. Without these a task
  // that restricted everything could neither recover nor be released.
  'browser_restrict', 'browser_reset_session', 'browser_reset',
])
function assertAllowed(state: ToolBrowserState, toolName: string, task: string): void {
  // browser_restrict must stay usable, or a task that restricted everything
  // could never lift it again.
  // An allow-list is a statement about ACTIONS, so it must not take away the ability to
  // look, or to get out of a bad state. The tool description and both READMEs promise
  // that read-only tools are never blocked; before this they were, because only
  // browser_restrict itself was exempt — a narrow list then locked browser_history,
  // browser_reset_session and browser_auth away with no way back.
  if (READ_ONLY_TOOLS.has(toolName) || toolName === 'browser_restrict') return
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
async function ensureSession(browser: NonNullable<Context['browser']>, state: ToolBrowserState, key: string, agent?: ExecAgent): Promise<BrowserSessionId> {
  const existing = state.sessionsByTask.get(key)
  if (existing !== undefined) {
    // The human closing a browser window ends that session, so a cached id can
    // be stale: never hand a dead session back to a tool call.
    if (browser.exists(existing)) return existing
    state.sessionsByTask.delete(key)
  }
  const pending = state.pendingOpens.get(key)
  if (pending !== undefined) return pending
  // The task key rides along as the session label so the window title shows
  // which task's page is currently visible to the human.
  const opening = browser.open(key).then(
    session => {
      // Tie the session's lifetime to the agent's scoped context FIRST: when
      // the agent (and its DSH session) is disposed, the effect's disposer
      // runs and closes the browser session. Registration happens once per
      // session (only on first open for the key). If the agent is already
      // gone, close the fresh session instead of leaking it.
      state.sessionsByTask.set(key, session)
      state.pendingOpens.delete(key)
      try {
        if (agent?.ctx !== undefined) {
          agent.ctx.effect(() => () => {
            const current = state.sessionsByTask.get(key)
            if (current === undefined) return
            state.sessionsByTask.delete(key)
            void browser.close(current).catch(() => {})
          })
        } else if (key === 'default') {
          // Agentless / CLI probe: close the session on process exit so the
          // window is not orphaned.
          // One hook for the whole process, not one listener per session: a default session can
          // be created repeatedly (a CLI probe does), and each registration lived for the life of
          // the process — so the listener list grew without bound and Node warned at eleven.
          registerExitCleanup(() => browser.close(session).catch(() => {}))
        }
      } catch (error) {
        // effect() failed — undo the registration so future calls retry.
        state.sessionsByTask.delete(key)
        void browser.close(session).catch(() => {})
        throw error
      }
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
}, options: { coords?: boolean } = {}): string {
  const showCoords = options.coords === true
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label}${el.selector !== undefined && el.selector !== '' ? ` {${el.selector}}` : ''}${el.frame === true ? ' (iframe)' : ''}${showCoords ? ` (${el.x},${el.y})` : ''}`)
  const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}`
  const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements found)'
  const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : ''
  const banner = snapshot.challenge?.blocked === true
    ? `\n\nCHALLENGE: ${snapshot.challenge.reason ?? 'human-verification'}. Do NOT keep retrying — ask the human to complete it in the shared browser window, then re-snapshot.`
    : ''
  return `${header}\n\n${body}${tail}${banner}`
}

/** Register all browser tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? 60_000
  /**
   * Longest wait `browser_wait` may poll for, leaving room for the tool call itself to
   * finish and report.
   *
   * `browser_wait` promises a VERDICT — `{ready:false, reason}` — and the enclosing tool
   * call aborts at `timeoutMs`. A caller-supplied budget longer than that aborted the call
   * instead, so the documented verdict never arrived. Clamping to just inside the budget is
   * what keeps the promise: the polling stops, the reason is returned.
   */
  const maxWaitMs = Math.max(250, timeoutMs - 5_000)
  /**
   * Most fields `browser_fill` accepts in one batch.
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
  liveStates.add(state)
  ctx.effect(() => () => { liveStates.delete(state) })
  // Re-apply resets the restriction: an omitted allowedActions lifts it.
  state.configRestrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined

  ctx.systemPrompt.section({
    name: 'tool:browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: 'Use the browser_* tools to operate the built-in browser. Each task gets its own browser session AND its own window (with a real toolbar: address bar, back/forward/reload, tab strip) — the human can see it, use it like any browser, and take over at any time; your tabs and history are isolated from other tasks, so do not assume another task\'s navigation state is visible to you. Understand a page with browser_a11y (semantic roles/names/states — the best structure map) or browser_snapshot (numbered interactive elements), then drive it: browser_click/browser_type accept a target {by: css|text|xpath, value} for semantic locating, or coordinates from browser_screenshot for visual targeting. For form filling prefer browser_fill (batch) or browser_set_value/browser_check/browser_select/browser_clear (single control, target-based); verify with browser_get_value. Use browser_scrape for structured extraction from list pages instead of hand-written browser_execute. After navigating on slow sites, browser_wait for the page. Keep the human informed of what you are doing on the page. If a snapshot or browser_challenge reports a human-verification challenge (CAPTCHA), stop retrying and ask the human to complete it in the browser window, then re-check.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a URL in the shared browser window. Opens this task\'s browser session on first use; optionally opens in a new tab. Returns the resulting page snapshot.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
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
      // browser_open is an overview of what just loaded, not a locator: it has no
      // `coords` parameter, so coordinates stay off here (browser_snapshot owns
      // that switch for callers that actually target pixels).
      render: (args, value) => [{ type: 'text', text: formatSnapshot(value, {}) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // opens tabs / navigates; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'browser_open', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.openUrl(session, {
        url: args.url,
        ...args.newTab === true ? { newTab: true } : {},
      }, exec.signal)
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, selector: el.selector, x: el.x, y: el.y, ...el.frame === true ? { frame: true } : {} })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return an AI-friendly snapshot of the current shared-browser page: numbered interactive elements (inputs, buttons, links) the model can cite. This is the primary way to understand a page, and it needs no image input — every listed element can afterwards be addressed by a semantic target (browser_click, browser_type, browser_check, …) rather than by coordinates.',
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
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, selector: el.selector, x: el.x, y: el.y, ...el.frame === true ? { frame: true } : {} })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_a11y',
    description: 'Read the page\'s accessibility tree: every interactive node with its semantic role (button/link/textbox/checkbox/…), accessible name, current value, and states (enabled/disabled/checked/expanded/…), (coordinates only when coords: true). Prefer this over browser_snapshot to understand a page\'s structure and find the right element: roles and names tell you WHAT each node is, and the name is what browser_click matches when you target by text. Penetrates same-origin iframes and shadow roots.',
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
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'number', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
                value: { type: 'string' },
                states: { type: 'array', required: true, items: { type: 'string' } },
                depth: { type: 'number', required: true },
                tag: { type: 'string', required: true },
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
        },
      },
      render: (args, value) => {
        const nodes = value.nodes as Array<{ ref: number; role: string; name: string; value?: string | null; states: string[]; depth: number; tag: string; x: number; y: number; frame?: boolean }>
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
          return `${indent}[${n.ref}] ${n.role} "${n.name}"${valuePart}${coordsPart}${statePart}${n.frame === true ? ' (iframe)' : ''}`
        })
        const header = `URL: ${value.url}${value.title !== undefined ? `\nTitle: ${value.title}` : ''}`
        const hint = showCoords ? '' : '\n(no coords; pass coords: true)'
        return [{ type: 'text', text: `${header}\n\n${lines.length > 0 ? lines.join('\n') : '(no accessible interactive nodes)'}${value.truncated === true ? '\n(truncated)' : ''}${hint}` }]
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
        nodes: result.nodes.map(n => ({
          ref: n.ref,
          role: n.role,
          name: n.name,
          ...n.value !== null ? { value: n.value } : {},
          states: [...n.states],
          depth: n.depth,
          tag: n.tag,
          x: n.x,
          y: n.y,
          ...n.frame === true ? { frame: true } : {},
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_challenge',
    description: 'Check whether a human-verification challenge (CAPTCHA / bot detection: Cloudflare "Just a moment", reCAPTCHA, hCaptcha, Turnstile) is blocking the current page. When blocked, do NOT keep retrying automated steps — ask the human to complete the verification in the shared browser window, then re-check with browser_snapshot.',
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
          ? 'Ask the human to complete the verification in the shared browser window (the page is visible to them), then re-check with browser_snapshot.'
          : '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: 'Wait until the shared-browser page is ready: load complete, and optionally the expected URL and/or a CSS selector present (top document or same-origin iframes). Use after browser_open on slow sites instead of snapshotting a white page — wait for the URL you navigated to first. Returns ready=true/false with a short reason; a miss is not an error.',
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

  ctx.tools.register(defineTool({
    name: 'browser_execute',
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
          ? `Result: ${rendered.slice(0, cap)}\n(result truncated at ${cap} of ${rendered.length} characters — return a smaller value, or write it with browser_execute + a variable)`
          : `Result: ${rendered}`
        return [{ type: 'text', text }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // page JS can be stateful
    async execute(args, exec) {
      assertAllowed(state, 'browser_execute', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_content',
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

  ctx.tools.register(defineTool({
    name: 'browser_scrape',
    description: 'Extract structured data from a page: give the container CSS selector (item) and a field map (name -> selector, optionally selector@attr to take an attribute; a@href yields the absolute URL). Returns one object per item. Static CSS queries only — no arbitrary code runs — so it is safe on any page. Use for list pages (search results, cards, tables) instead of hand-writing browser_execute.',
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
      assertAllowed(state, 'browser_scrape', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click in the shared browser. Prefer the semantic target: pass target {by: css|text|xpath, value, index?} and the element is located from the DOM, scrolled into view and clicked at its centre — this needs no image input and is the only form that works without vision. The alternative is viewport coordinates (x/y), which are meaningful only after a vision model has located the element on a browser_screenshot; coordinate clicks are refused outright under the non-visual strategy. Provide exactly one of target or x/y.',
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
      x: { type: 'number', description: 'Viewport x coordinate (CSS px), taken from a browser_screenshot read by a vision model. Prefer a semantic target — it works without image input.' },
      y: { type: 'number', description: 'Viewport y coordinate (CSS px), taken from the same screenshot as x.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' : 'Click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_click', taskKey(exec))
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
          throw new Error('browser_click: provide a target (css/text/xpath) or x/y coordinates')
        }
        await browser.click(session, { x: args.x, y: args.y }, exec.signal)
      }
      return { clicked: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the focused element of the shared browser, or into a located element (pass target {by: css|text|xpath, value, index?} to focus it first). Text is inserted at the focus via CDP Input.insertText. For setting whole field values (and React-controlled inputs) prefer browser_set_value; use browser_key for Enter/Tab/arrows.',
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
      schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` : 'Type failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_type', taskKey(exec))
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
      return { typed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the shared-browser page: by pixel deltas (deltaX/deltaY), to a CSS selector\'s element, or to the top/bottom. Use to reveal below-the-fold content before snapshotting or clicking.',
    parameters: {
      deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS pixels.' },
      deltaY: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' },
      selector: { type: 'string', description: 'Scroll the element matching this CSS selector into view.' },
      toTop: { type: 'boolean', description: 'Scroll to the top of the page.' },
      toBottom: { type: 'boolean', description: 'Scroll to the bottom of the page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { scrolled: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.scrolled ? 'Scrolled.' : 'Scroll failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page scroll state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'browser_scroll', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.scroll(session, {
        ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
        ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.toTop === true ? { toTop: true } : {},
        ...args.toBottom === true ? { toBottom: true } : {},
      }, exec.signal)
      return { scrolled: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_back',
    description: 'Go back one step in the shared-browser page history. A no-op when there is no previous entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { back: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.back ? 'Went back.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'browser_back', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.back(session, exec.signal)
      return { back: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_forward',
    description: 'Go forward one step in the shared-browser page history. A no-op when there is no next entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { forward: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.forward ? 'Went forward.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'browser_forward', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.forward(session, exec.signal)
      return { forward: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_refresh',
    description: 'Reload the current page in the shared browser (like a browser\'s refresh button). Use after a page got stuck, to apply script changes, or to re-fetch a page.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { refreshed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.refreshed ? 'Page reloaded.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // reloads the page; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'browser_refresh', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.reload(session, exec.signal)
      return { refreshed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_key',
    description: 'Press one named key in the shared-browser page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). Use after focusing an input to submit a chat box (Enter), move focus (Tab), or navigate a list (arrows).',
    parameters: {
      key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'], description: 'The key to press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` : 'Key press failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'browser_key', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.key(session, { key: args.key }, exec.signal)
      return { pressed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: 'Fill a form in one batch: pass fields with a CSS selector or name/label/placeholder text and the value to set (string, number, or boolean for checkbox/radio; for selects or radio groups pass the option value or visible text). Values are applied with the native setter plus input/change events, so React/Vue controlled inputs update correctly. Optionally submit the containing form. Prefer this over hand-written browser_execute for form filling; per-field failures are reported instead of throwing.',
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
      assertAllowed(state, 'browser_fill', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const requested = args.fields ?? []
      if (requested.length > maxFillFields) {
        throw new Error(`browser_fill: ${requested.length} fields in one call exceeds the ${maxFillFields}-field limit; split it into several calls so each one can report per-field results instead of timing out as a batch`)
      }
      const fields = requested.map((f: { selector?: string; name?: string; label?: string; placeholder?: string; kind?: string; value?: string }) => {
        // A missing value is a caller mistake, not a request to clear the field. Turning
        // it into '' silently unchecks a checkbox or empties a text input while the tool
        // still reports success, so it fails loudly. The schema marks value required, but
        // a call can still arrive without it.
        if (f.value === undefined) {
          const matcher = f.selector ?? f.name ?? f.label ?? f.placeholder ?? '(no matcher)'
          throw new Error(`browser_fill: field "${matcher}" has no "value"; pass one (use "false" to uncheck, or "" to clear deliberately)`)
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

  ctx.tools.register(defineTool({
    name: 'browser_set_value',
    description: 'Set the value of ONE input/textarea/select/contenteditable, located by css/text/xpath. Uses the native setter plus input/change events, so React/Vue controlled inputs update correctly. For selects pass the option value or visible text. For a whole form at once prefer browser_fill.',
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
      assertAllowed(state, 'browser_set_value', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_check',
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
      assertAllowed(state, 'browser_check', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_select',
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
      assertAllowed(state, 'browser_select', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_clear',
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
      assertAllowed(state, 'browser_clear', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_get_value',
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
      assertAllowed(state, 'browser_get_value', taskKey(exec))
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

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current shared-browser page as a screenshot (PNG default, JPEG optional). This is for models that can read images: layout checks, charts, designs, CAPTCHAs, or locating an element by eye before clicking its coordinates. A model without image input gains nothing from it — browser_snapshot, browser_a11y and browser_content carry the same page as text, and browser_scrape extracts structured data. Supports full-page capture, save-to-file, JPEG encoding, and downscaling (maxWidth/maxHeight) to cut vision-tool token cost. JPEG needs a browser whose CDP encoder works — the self-hosted browser and an installed Chrome/Edge; some carriers (the desktop sidebar) return PNG instead. Downscaling works on every carrier.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
      savePath: { type: 'string', description: 'Absolute file path to also save the image to (e.g. for read_image vision location). Must resolve inside the configured downloadDir (default: the system Downloads folder, localized names such as ~/下载 included); an existing file is never overwritten.' },
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
          dataUrl: { type: 'string', required: true, description: 'Base64 PNG data URL of the screenshot.' },
          path: { type: 'string', description: 'The file path the screenshot was saved to, when savePath was given.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Screenshot captured (${Math.round(value.dataUrl.length * 3 / 4 / 1024)} KiB)${value.path !== undefined ? ` saved to ${value.path}` : ''}.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const shot = await browser.screenshot(session, {
        ...args.fullPage === true ? { fullPage: true } : {},
        ...args.savePath !== undefined ? { savePath: args.savePath } : {},
        ...args.format !== undefined ? { format: args.format } : {},
        ...args.quality !== undefined ? { quality: args.quality } : {},
        ...args.maxWidth !== undefined ? { maxWidth: args.maxWidth } : {},
        ...args.maxHeight !== undefined ? { maxHeight: args.maxHeight } : {},
      }, exec.signal)
      return {
        dataUrl: shot.dataUrl,
        ...shot.path !== undefined ? { path: shot.path } : {},
      }
    },
  }))

  if (config.tabTools !== false) {
    ctx.tools.register(defineTool({
      name: 'browser_list_tabs',
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
        return { tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'browser_switch_tab',
      description: 'Switch the shared browser to a tab by id (from browser_list_tabs).',
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
        assertAllowed(state, 'browser_switch_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        await browser.switchTab(session, args.tabId)
        return { switched: true }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'browser_close_tab',
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
        assertAllowed(state, 'browser_close_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        await browser.closeTab(session, args.tabId)
        return { closed: true }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'browser_reset',
      description: 'Close every tab in the shared browser and start fresh with one blank tab.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser reset.' : 'Failed.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // closes every tab; exclusive within a task
      async execute(_args, exec) {
        assertAllowed(state, 'browser_reset', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        await browser.reset(session)
        return { reset: true }
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_history',
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
      render: (_args, value) => {
        const entries = value.entries as Array<{ seq: number; action: string; ok: boolean; params: Record<string, unknown>; result?: string; error?: string }>
        if (entries.length === 0) return [{ type: 'text', text: '(no recorded operations yet)' }]
        // The parameters are what the caller itself just sent, so echoing them back is cost
        // without information — measured at 18,162 characters for 200 operations, of which the
        // per-entry params dominated. Only the tail is shown by default: the recent steps are
        // what a caller reasons about, and the count leads so the tail is not mistaken for all.
        const recent = entries.slice(-20)
        const omitted = entries.length - recent.length
        const lines = recent.map(e => `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`)
        const header = omitted > 0
          ? `${entries.length} operations recorded; showing the last ${recent.length} (pass verbose: true for their parameters):`
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

  ctx.tools.register(defineTool({
    name: 'browser_visited',
    description: 'List pages the shared browser has visited, newest first, from the PERSISTENT browsing history: it survives closing the browser and restarting DSH, so it is how you (or the human) find a page again afterwards. Reopen one by passing its url to browser_open. Not to be confused with browser_history, which is only the current session\'s operation log (navigate/click/type) and disappears with the session.',
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

  ctx.tools.register(defineTool({
    name: 'browser_replay',
    description: 'Replay one recorded browser operation by its history sequence number (from browser_history). Navigate/click/type are re-issued against the current page; execute re-runs its script. The replayed step is appended to history as a new entry.',
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
      assertAllowed(state, 'browser_replay', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.replay(session, args.seq)
      return { replayed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_download',
    description: 'Download a URL to a local file, keeping the browser session\'s cookies and login state. Use for fetching files behind authentication or from the current page context. Available on the self-hosted browser; the desktop shell delegates downloads to the real browser UI.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to download.' },
      savePath: { type: 'string', required: true, description: 'Absolute path of the file to write. Must resolve inside the configured downloadDir (default: the system Downloads folder, localized names such as ~/下载 included); an existing file is never overwritten.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Downloaded to ${value.path}.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_download', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal)
      return { path: result.path }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_session',
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
      return { session, tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_reset_session',
    description: 'Reset THIS task\'s browser session: close it entirely so the next browser_* call starts a fresh session with one blank tab. Other tasks\' sessions are untouched. Use when a session is in a bad state or you want a clean slate.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.reset ? 'This task\'s browser session was closed; the next call starts fresh.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // closes the whole session; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'browser_reset_session', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
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

  ctx.tools.register(defineTool({
    name: 'browser_restrict',
    description: 'Restrict which browser actions are allowed, to prevent stray clicks/navigation. Pass a list of browser tool names (e.g. ["browser_snapshot","browser_content","browser_click"]) — any other browser_* call is refused. Pass an empty list or omit to lift the restriction. Never blocked, whatever the list says: the observing tools (snapshot/a11y/content/scrape/screenshot/get_value/wait/challenge/list_tabs/session/history/visited) and the three that lift a restriction or recover from a bad state (restrict/reset/reset_session) — so a restriction can always be read around and undone. IMPORTANT: this is a SOFT guardrail against accidental actions, NOT a security boundary — you (the model) can lift it yourself with an empty list.',
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
      const unknown = allowed.filter((t: string) => !t.startsWith('browser_'))
      if (unknown.length > 0) {
        throw new Error(`browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "browser_")`)
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

  ctx.tools.register(defineTool({
    name: 'browser_auth',
    description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list (save it to a private file to persist logins), or "restore" with that list to put logins back (e.g. after the browser host restarted). Available on all three carriers: the self-hosted browser reads its own session, while the desktop sidebar and an installed Chrome/Edge go through CDP. Refused entirely when the credential switch is off. Exported cookies are LIVE CREDENTIALS: treat them as secrets — do not echo them into the conversation, keep them out of logs, and store the list in a private file.',
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
      assertAllowed(state, 'browser_auth', taskKey(exec))
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
        throw new Error('browser_auth: action "restore" needs a non-empty "cookies" array (get one from action "flush" on the same profile)')
      }
      const list = args.cookies as unknown[]
      const restored = await browser.restoreAuth(session, list as never)
      return { restored }
    },
  }))
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

