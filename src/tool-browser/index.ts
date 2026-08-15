/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting 鈥?never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: the
 * first `browser_open` (or any tool when no session exists) opens a session;
 * later tools reuse it. Per-agent isolation is a follow-up.
 * @module dsh-browser/tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BrowserSessionId } from '../browser/types.ts'

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

/** One plugin-level browser session, opened lazily. */
let currentSession: BrowserSessionId | undefined

/**
 * Action restriction state: an allow-list of browser tool names, or undefined
 * for unrestricted. When set, any browser_* tool not in the list is refused
 * (browser_restrict itself is always allowed so the guard can be lifted).
 */
let restrictedTo: readonly string[] | undefined

/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param toolName - the browser tool about to run.
 */
function assertAllowed(toolName: string): void {
  if (restrictedTo === undefined) return
  if (restrictedTo.includes(toolName)) return
  throw new Error(`browser action "${toolName}" is restricted (allow-list: ${restrictedTo.join(', ')})`)
}

/**
 * Resolve the active session, opening one on first use.
 * @param browser - the seam service.
 * @returns the active session id.
 */
async function ensureSession(browser: NonNullable<Context['browser']>): Promise<BrowserSessionId> {
  if (currentSession === undefined) {
    currentSession = await browser.open()
  }
  return currentSession
}

/** Format a snapshot element list for the model. */
function formatSnapshot(snapshot: {
  url: string
  title?: string
  elements: readonly { ref: number; kind: string; label: string; x: number; y: number }[]
  truncated?: boolean
}): string {
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label} (${el.x},${el.y})`)
  const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}`
  const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements found)'
  const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : ''
  return `${header}\n\n${body}${tail}`
}

/** Register all browser tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? 60_000
  if (config.allowedActions !== undefined) restrictedTo = [...config.allowedActions]

  ctx.systemPrompt.section({
    name: 'tool:browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: 'Use the browser_* tools to operate a real shared browser the human can see and take over. Locate elements by snapshot reference numbers (browser_snapshot) and drive them with browser_execute (DOM-referenced JS, native setters for framework inputs). browser_screenshot is for visual confirmation, not primary targeting. Keep the human informed of what you are doing on the page.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a URL in the shared browser. Opens a new session on first use; optionally opens in a new tab. Returns the resulting page snapshot.',
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed('browser_open')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y })),
        truncated: snapshot.truncated,
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
      assertAllowed('browser_execute')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
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
      const session = await ensureSession(browser)
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
      assertAllowed('browser_click')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
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
      assertAllowed('browser_type')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      await browser.type(session, { text: args.text }, exec.signal)
      return { typed: true }
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
      const session = await ensureSession(browser)
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
      async execute(_args, _exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser)
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
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser)
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
      isConcurrencySafe: () => true,
      async execute(args, _exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser)
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
      isConcurrencySafe: () => true,
      async execute(_args, _exec) {
        assertAllowed('browser_reset')
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser)
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
          text: entries.map(e =>
            `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'} ${JSON.stringify(e.params)}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`,
          ).join('\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, _exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      const entries = await browser.history(session)
      const rendered = entries.map(e => {
        const row: { seq: number; action: string; ok: boolean; params: unknown; result?: string; error?: string } = {
          seq: e.seq,
          action: e.action,
          ok: e.ok,
          params: JSON.parse(JSON.stringify(e.params)),
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
    async execute(args, _exec) {
      assertAllowed('browser_replay')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
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
      assertAllowed('browser_download')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      const result = await browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal)
      return { path: result.path }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_session',
    description: 'Show the shared browser session: its id, open tabs, and whether it is active. All agents in this process share one browser session (same cookies/login state), so this reflects what every caller drives.',
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
    async execute(_args, _exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      const tabs = await browser.listTabs(session)
      return { session, tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_reset_session',
    description: 'Reset the shared browser session: close every tab and start fresh with one blank tab. Use when a session is in a bad state or you want a clean slate (the shared session stays the same id, so other agents pick it up too).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser session reset.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, _exec) {
      assertAllowed('browser_reset_session')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
      await browser.reset(session)
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
    async execute(args, _exec) {
      // Always allowed so the guard can be lifted.
      restrictedTo = (args.allowed ?? []).filter((t: string) => t.startsWith('browser_'))
      return { restrictedTo: [...restrictedTo] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_auth',
    description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list (save it to a file to persist logins), or "restore" with that list to put logins back (e.g. after the browser host restarted). Available on the self-hosted browser.',
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
      render: (_args, value) => [{ type: 'text', text: value.cookies !== undefined ? `Exported ${(value.cookies as unknown[]).length} cookies.` : `Restored ${value.restored} cookies.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      assertAllowed('browser_auth')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser)
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

/** Test hook: clear the plugin-level session (used by tests and on reset). */
export const internals = {
  get session(): BrowserSessionId | undefined { return currentSession },
  clearSession(): void { currentSession = undefined },
}

