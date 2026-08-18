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
   * Action restriction: an allow-list of browser tool names, or undefined for
   * unrestricted. When set, any browser_* tool not in the list is refused
   * (browser_restrict itself is always allowed so the guard can be lifted).
   * Scoped to one plugin apply (one context), so a restriction set by one
   * task never leaks into another context.
   */
  restrictedTo: readonly string[] | undefined
}

function createState(): ToolBrowserState {
  return { sessionsByTask: new Map(), pendingOpens: new Map(), restrictedTo: undefined }
}

/** Every live state, for the test hook (introspection only, never shared). */
const liveStates = new Set<ToolBrowserState>()

/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param state - the calling context's tool state.
 * @param toolName - the browser tool about to run.
 */
function assertAllowed(state: ToolBrowserState, toolName: string): void {
  const { restrictedTo } = state
  if (restrictedTo === undefined) return
  if (restrictedTo.includes(toolName)) return
  throw new Error(`browser action "${toolName}" is restricted (allow-list: ${restrictedTo.join(', ')})`)
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
  if (existing !== undefined) return existing
  const pending = state.pendingOpens.get(key)
  if (pending !== undefined) return pending
  const opening = browser.open().then(
    session => {
      // Tie the session's lifetime to the agent's scoped context FIRST: when
      // the agent (and its DSH session) is disposed, the effect's disposer
      // runs and closes the browser session. Registration happens once per
      // session (only on first open for the key). If the agent is already
      // gone, close the fresh session instead of leaking it.
      try {
        agent?.ctx?.effect(() => () => {
          const current = state.sessionsByTask.get(key)
          if (current === undefined) return
          state.sessionsByTask.delete(key)
          void browser.close(current).catch(() => {})
        })
      } catch (error) {
        void browser.close(session).catch(() => {})
        throw error
      }
      state.sessionsByTask.set(key, session)
      state.pendingOpens.delete(key)
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
  if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v)
  return v ?? ''
}

/** Format a snapshot element list for the model. */
function formatSnapshot(snapshot: {
  url: string
  title?: string
  elements: readonly { ref: number; kind: string; label: string; x: number; y: number }[]
  truncated?: boolean
  challenge?: { blocked: boolean; kind?: string; reason?: string }
}): string {
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label} (${el.x},${el.y})`)
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
  // Per-context state: sessions, in-flight opens, and the restriction are
  // scoped to THIS plugin apply, so parallel contexts never share sessions
  // or leak restrictions into each other.
  const state = createState()
  liveStates.add(state)
  ctx.effect(() => () => { liveStates.delete(state) })
  // Re-apply resets the restriction: an omitted allowedActions lifts it.
  state.restrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined

  ctx.systemPrompt.section({
    name: 'tool:browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: 'Use the browser_* tools to operate a real shared browser the human can see and take over. Locate elements by snapshot reference numbers (browser_snapshot) and drive them with browser_execute (DOM-referenced JS, native setters for framework inputs). For form filling prefer browser_fill, which handles controlled inputs, selects, checkboxes and radio groups in one batch. browser_screenshot is for visual confirmation, not primary targeting. Keep the human informed of what you are doing on the page. Each task gets its own browser session: your tabs and history are isolated from other tasks, so do not assume another task\'s navigation state is visible to you. If a snapshot or browser_challenge reports a human-verification challenge (CAPTCHA), stop retrying and ask the human to complete it in the shared browser window, then re-check.',
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
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // opens tabs / navigates; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'browser_open')
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
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return an AI-friendly snapshot of the current shared-browser page: numbered interactive elements (inputs, buttons, links) the model can cite. Use this to understand an interactive page before driving it.',
    parameters: {},
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
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
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
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
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
      render: (_args, value) => [{ type: 'text', text: value.ok ? `Result: ${String(value.value)}` : `Exception: ${value.exception}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // page JS can be stateful
    async execute(args, exec) {
      assertAllowed(state, 'browser_execute')
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
      render: (_args, value) => [{ type: 'text', text: value.content + (value.truncated ? '\n(truncated)' : '') }],
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
    name: 'browser_click',
    description: 'Click at viewport coordinates (CSS pixels) in the shared browser. Use with browser_screenshot: have a vision model locate an element on the screenshot, then click its coordinates — this covers icons, image buttons, and canvas elements that DOM snapshots cannot target. Coordinates are relative to the visible viewport, same as the screenshot.',
    parameters: {
      x: { type: 'number', required: true, description: 'Viewport x coordinate (CSS px), e.g. from a vision model reading the screenshot.' },
      y: { type: 'number', required: true, description: 'Viewport y coordinate (CSS px).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' : 'Click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_click')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.click(session, { x: args.x, y: args.y }, exec.signal)
      return { clicked: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the focused element of the shared browser. Use after browser_execute focuses an input (e.g. el.focus()), or after a click lands in a field. Text is inserted at the current focus via CDP Input.insertText.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to insert.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` : 'Type failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_type')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.type(session, { text: args.text }, exec.signal)
      return { typed: true }
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
            value: { type: 'string', description: 'Value to set (string form; booleans/numbers accepted as strings).' },
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
      assertAllowed(state, 'browser_fill')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const fields = (args.fields ?? []).map((f: { selector?: string; name?: string; label?: string; placeholder?: string; kind?: string; value?: string }) => ({
        ...f.selector !== undefined ? { selector: f.selector } : {},
        ...f.name !== undefined ? { name: f.name } : {},
        ...f.label !== undefined ? { label: f.label } : {},
        ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
        ...f.kind !== undefined ? { kind: f.kind as 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' } : {},
        value: parseFillValue(f.value),
      }))
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

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current shared-browser page as a PNG screenshot. Use for visual confirmation of layout, charts, designs, or CAPTCHAs, or to feed a vision tool (read_image) that locates elements visually. Supports optional full-page capture and optional save-to-file (the saved path can be passed to read_image for vision-based element location).',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
      savePath: { type: 'string', description: 'Absolute file path to also save the PNG to (e.g. for read_image vision location).' },
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
        assertAllowed(state, 'browser_switch_tab')
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
        assertAllowed(state, 'browser_reset')
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
    parameters: {},
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
        return [{
          type: 'text',
          text: entries.map(e => {
            const rawParams = JSON.stringify(e.params)
            const shownParams = rawParams.length > 300 ? rawParams.slice(0, 300) + '…' : rawParams
            return `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'} ${shownParams}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`
          }).join('\n'),
        }]
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
        // Typed text (possibly passwords) is kept verbatim in the provider's
        // history so replay can re-issue it, but must not be echoed back to
        // the model: mask it in the tool output, preserving the length.
        if (e.action === 'type' && typeof params.text === 'string') {
          params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`
        }
        const row: { seq: number; action: string; ok: boolean; params: unknown; result?: string; error?: string } = {
          seq: e.seq,
          action: e.action,
          ok: e.ok,
          params,
        }
        if (e.result !== undefined) row.result = e.result
        if (e.error !== undefined) row.error = e.error
        return row
      })
      return { entries: rendered as never }
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
      assertAllowed(state, 'browser_replay')
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
      savePath: { type: 'string', required: true, description: 'Absolute path of the file to write.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Downloaded to ${value.path}.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'browser_download')
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
      assertAllowed(state, 'browser_reset_session')
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
    description: 'Restrict which browser actions are allowed, to prevent stray clicks/navigation. Pass a list of browser tool names (e.g. ["browser_snapshot","browser_content","browser_click"]) — any other browser_* call is refused. Pass an empty list or omit to lift the restriction. Read-only tools (snapshot/content/screenshot/session) are never blocked.',
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
      // Empty list (or omitted) lifts the restriction; a non-empty list is the
      // new allow-list. Scoped to this plugin apply (this context) only.
      state.restrictedTo = allowed.length === 0 ? undefined : [...allowed]
      return { restrictedTo: state.restrictedTo === undefined ? [] : [...state.restrictedTo] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_auth',
    description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list (save it to a private file to persist logins), or "restore" with that list to put logins back (e.g. after the browser host restarted). Available on the self-hosted browser. Exported cookies are LIVE CREDENTIALS: treat them as secrets — do not echo them into the conversation, keep them out of logs, and store the list in a private file.',
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
      assertAllowed(state, 'browser_auth')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      if (args.action === 'flush') {
        const cookies = await browser.flushAuth(session)
        return { cookies: cookies.map(c => ({ ...c })) as never }
      }
      const list = (args.cookies ?? []) as unknown[]
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

