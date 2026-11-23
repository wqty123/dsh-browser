/**
 * Observation tools: snapshots, accessibility, content, scrape, screenshot, state, find, challenge.
 * @module dsh-browser/tool-browser/tools-observation
 */

import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { SCREENSHOT_MAX_WIDTH, SCREENSHOT_MAX_HEIGHT, screenshotDimension, screenshotBytes, screenshotVisionEnabled, saveScreenshotImage } from './screenshot-image.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { NODE_ITEM_SCHEMA, projectElement, projectNode } from './element-fields.ts'
import { assertCapability } from '../browser/types.ts'
import { assertAllowed, agentOf, taskKey, ensureSession, carrierCapabilities, type ToolScope, type ToolDefinition } from './state.ts'
import { installProbe, probe, type ProbeRow } from './probe-client.ts'

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
export function formatSnapshot(snapshot: {
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

/**
 * Define this module's tools for one apply.
 * @param scope - the apply's context, settings and per-apply state.
 * @returns the tool definitions, for the entry to register.
 */
export function observationTools(scope: ToolScope): ToolDefinition[] {
  const { ctx, state, timeoutMs } = scope
  const tools: ToolDefinition[] = []

  tools.push(defineTool({
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

  tools.push(defineTool({
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

  tools.push(defineTool({
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

  tools.push(defineTool({
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

  tools.push(defineTool({
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

  tools.push(defineTool({
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
      assertCapability(carrierCapabilities(browser, state, key), 'screenshot',
        'Web 侧栏暂不支持截图：iframe 无法被网页静默截图 (panel surface unavailable). Use the CDP-backed DSH desktop sidebar with a connected desktop bridge for screenshots.')
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

  tools.push(defineTool({
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

  tools.push(defineTool({
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

  return tools
}
