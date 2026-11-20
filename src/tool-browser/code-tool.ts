/**
 * dsh_browser_code: the single model-facing browser tool.
 *
 * The model writes a short async JavaScript body; it runs on the host with a
 * small browser API in scope, so a whole run of actions (open, click, type,
 * wait, read, decide, repeat) is ONE tool call. Every helper dispatches to the
 * registered dsh_browser_* implementation, so restriction, takeover blocking,
 * per-task sessions, references and the vision-gated screenshot path are the
 * same as when those tools were called directly.
 */
import { runInNewContext } from 'node:vm'
import { inspect } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

export const CODE_TOOL = 'dsh_browser_code'
const PREFIX = 'dsh_browser_'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000
const MAX_IMAGES = 4

/** The slice of a registered tool definition the code tool dispatches to. */
export interface CatalogTool {
  readonly name: string
  readonly description?: string
  readonly output?: { readonly render?: (args: never, value: never) => readonly unknown[] }
  execute(args: never, exec: never): Promise<unknown>
}

interface ImageAttachment { attachmentId: string; mediaType: string; bytes: number; width: number; height: number }

interface Block { readonly type: string; readonly text?: string; readonly attachment?: unknown }

export type Target = string | number | {
  readonly css?: string; readonly text?: string; readonly xpath?: string
  readonly by?: 'css' | 'text' | 'xpath'; readonly value?: string; readonly index?: number
  readonly x?: number; readonly y?: number
}

/**
 * Turn a helper target into the {target} / {x, y} arguments of click and type.
 * A string is visible text unless it looks like a CSS selector or XPath.
 * @param target - text, selector, {css|text|xpath}, {by, value} or {x, y}.
 */
export function targetArgs(target: Target): Record<string, unknown> {
  if (typeof target === 'number') throw new Error('targets are text, a CSS selector, {css}, {text}, {xpath} or {x, y}; snapshot numbers are not targets')
  if (typeof target === 'string') {
    if (target.startsWith('//') || target.startsWith('(//')) return { target: { by: 'xpath', value: target } }
    if (looksLikeSelector(target)) return { target: { by: 'css', value: target } }
    return { target: { by: 'text', value: target } }
  }
  if (target === null || typeof target !== 'object') throw new Error(`invalid target ${JSON.stringify(target)}`)
  if (typeof target.x === 'number' && typeof target.y === 'number') return { x: target.x, y: target.y }
  const index = target.index !== undefined ? { index: target.index } : {}
  if (target.css !== undefined) return { target: { by: 'css', value: target.css, ...index } }
  if (target.text !== undefined) return { target: { by: 'text', value: target.text, ...index } }
  if (target.xpath !== undefined) return { target: { by: 'xpath', value: target.xpath, ...index } }
  if (target.value !== undefined) return { target: { by: target.by ?? 'css', value: target.value, ...index } }
  throw new Error(`invalid target ${JSON.stringify(target)}`)
}

const HTML_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'div', 'span', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'tbody', 'thead', 'img', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside', 'option', 'summary', 'details', 'iframe', 'body', 'svg', 'dialog'])

function looksLikeSelector(value: string): boolean {
  if (/^[#.[]\S/.test(value)) return true
  const tag = /^[a-z][a-z0-9-]*/.exec(value)?.[0]
  if (tag === undefined || !HTML_TAGS.has(tag)) return false
  return value.length === tag.length || /^[#.[:]/.test(value.slice(tag.length)) || /^\s*>/.test(value.slice(tag.length))
}

function blocksText(blocks: readonly Block[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try { return JSON.stringify(value, null, 1) ?? String(value) } catch { return inspect(value, { depth: 4 }) }
}

const DESCRIPTION = [
  'Drive the built-in browser by running JavaScript (an async function body; use await, loops, if, try/catch). Batch a whole run of steps into ONE call, e.g. open, type, submit, wait and read, and only return what you need. Each conversation has its own browser session; the human can watch.',
  'Helpers (all async):',
  '- open(url) - navigate (opens the session) and return a page summary.',
  '- click(target), type(target, text, {submit}) or type(text) into the focused field, press(key), scroll(deltaY | {toBottom|toTop|selector}), back(), select(target, option), fill(fields)',
  '  target: visible text ("Sign in"), a CSS selector ("#q", "input[name=q]"), {text|css|xpath, index}, or {x, y} from a screenshot.',
  '- read({format, selector, maxChars}) - page text (markdown by default). snapshot() - numbered interactive elements with labels. find(text) - where text occurs.',
  '- js(expr) - evaluate JavaScript in the page and return its value (best for extracting lists/tables as JSON).',
  '- waitFor({text|gone|url|selector, timeoutMs}) - wait for the page; sleep(ms).',
  '- screenshot({fullPage}) - capture the page; vision models see the image.',
  '- tabs(), state(), refs.capture({excerptText}), refs.list(), refs.reveal({referenceId}).',
  '- call(name, args) - any other browser action by name (e.g. "download", "console", "network", "dialog", "switch_tab", "set_value", "check", "scrape", "a11y", "do") returning its structured result; help() lists them.',
  '- log(...values) prints; the function\'s return value is printed too. A failed helper throws; catch it to try another way.',
  'On a CAPTCHA, login, 2FA or payment, call dsh_browser_request_takeover instead of solving it.',
].join('\n')

/**
 * Build the code tool over a catalog of registered browser tools.
 * @param catalog - every browser tool by name, already wrapped with the takeover and restriction gates.
 * @param options - the tool timeout used for one helper call.
 */
export function createCodeTool(catalog: ReadonlyMap<string, CatalogTool>, options: { readonly timeoutMs: number }) {
  return defineTool({
    name: CODE_TOOL,
    description: DESCRIPTION,
    parameters: {
      code: { type: 'string', required: true, description: 'Async JavaScript function body using the helpers; return the result you want to see.' },
      timeoutMs: { type: 'number', description: `Budget for the whole run (default ${DEFAULT_TIMEOUT_MS}, max 600000).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          calls: { type: 'number', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.output },
        ...value.images.map(attachment => ({ type: 'image' as const, attachment: attachment as ImageBlock['attachment'] })),
      ],
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolRunContext) {
      if (typeof args.code !== 'string' || args.code.trim() === '') throw new Error('code must be a non-empty JavaScript function body')
      const budget = Math.min(Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 1000), 600_000)
      const controller = new AbortController()
      const onAbort = () => controller.abort(exec.signal?.reason)
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error(`code run exceeded ${budget}ms`)), budget)
      const lines: string[] = []
      const images: ImageAttachment[] = []
      let calls = 0
      const log = (...values: unknown[]) => { lines.push(values.map(format).join(' ')) }

      const resolve = (name: string): CatalogTool => {
        const full = name.startsWith(PREFIX) ? name : PREFIX + name
        const tool = catalog.get(full)
        if (tool === undefined) throw new Error(`unknown browser action "${name}"; help() lists them`)
        return tool
      }
      const run = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<{ value: unknown; blocks: readonly Block[] }> => {
        controller.signal.throwIfAborted()
        const tool = resolve(name)
        calls++
        const value = await tool.execute(toolArgs as never, { ...exec, signal: controller.signal } as never)
        const blocks = (tool.output?.render?.(toolArgs as never, value as never) ?? [{ type: 'text', text: format(value) }]) as readonly Block[]
        for (const block of blocks) {
          if (block.type === 'image' && block.attachment !== undefined && images.length < MAX_IMAGES) images.push(block.attachment as ImageAttachment)
        }
        return { value, blocks }
      }
      const text = async (name: string, toolArgs?: Record<string, unknown>) => blocksText((await run(name, toolArgs)).blocks)
      const value = async (name: string, toolArgs?: Record<string, unknown>) => (await run(name, toolArgs)).value

      const api = {
        call: value,
        callText: text,
        open: (url: string, extra: Record<string, unknown> = {}) => text('open', { url, ...extra }),
        click: (target: Target, extra: Record<string, unknown> = {}) => text('click', { ...targetArgs(target), ...extra }),
        type: async (target: Target | undefined, input?: string | { submit?: boolean }, opts: { submit?: boolean } = {}) => {
          let typed: string
          let toolArgs: Record<string, unknown>
          if (typeof input === 'string') { typed = input; toolArgs = { ...targetArgs(target as Target), text: input } } else {
            typed = String(target); toolArgs = { text: typed }; opts = input ?? opts
          }
          let out = await text('type', toolArgs)
          if (opts.submit === true) out += '\n' + await text('key', { key: 'Enter' })
          return out
        },
        press: (key: string) => text('key', { key }),
        scroll: (delta: number | Record<string, unknown> = 800) => text('scroll', typeof delta === 'number' ? { deltaY: delta } : delta),
        back: () => text('back'),
        forward: () => text('forward'),
        refresh: () => text('refresh'),
        select: (target: Target, option: string) => text('select', { ...targetArgs(target), optionText: option }),
        fill: (fields: readonly Record<string, unknown>[]) => text('fill', { fields }),
        read: (opts: Record<string, unknown> = {}) => value('content', { format: 'markdown', maxChars: 20000, ...opts }).then(v => {
          const out = v as { content?: string; truncated?: boolean }
          return (out.content ?? '') + (out.truncated === true ? '\n[truncated; pass selector or maxChars]' : '')
        }),
        snapshot: (opts: Record<string, unknown> = {}) => text('snapshot', opts),
        find: (needle: string, opts: Record<string, unknown> = {}) => text('find', { text: needle, ...opts }),
        js: async (script: string) => {
          const out = await value('execute', { script }) as { ok: boolean; value?: string; exception?: string }
          if (!out.ok) throw new Error(`page script failed: ${out.exception ?? 'unknown error'}`)
          if (out.value === undefined) return undefined
          try { return JSON.parse(out.value) } catch { return out.value }
        },
        waitFor: async (opts: Record<string, unknown> = {}) => {
          const timeout = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}
          if (opts.selector !== undefined || opts.url !== undefined) {
            const out = await value('wait', { ...opts.selector !== undefined ? { selector: opts.selector } : {}, ...opts.url !== undefined ? { url: opts.url } : {}, ...timeout }) as { ready: boolean; reason: string }
            if (!out.ready) throw new Error(`waitFor timed out: ${out.reason}`)
          }
          const steps: Record<string, unknown>[] = []
          if (opts.text !== undefined) steps.push({ wait_text: { text: opts.text } })
          if (opts.gone !== undefined) steps.push({ wait_gone: { text: opts.gone } })
          if (steps.length === 0 && opts.selector === undefined && opts.url === undefined) steps.push({ wait_idle: {} })
          if (steps.length > 0) {
            const out = await value('do', { steps, ...timeout }) as { ok: boolean; reason?: string }
            if (!out.ok) throw new Error(`waitFor failed: ${out.reason ?? 'condition not met'}`)
          }
          return true
        },
        screenshot: (opts: Record<string, unknown> = {}) => text('screenshot', opts),
        tabs: () => text('list_tabs'),
        state: () => text('state'),
        refs: {
          capture: (opts: Record<string, unknown> = {}) => text('reference_capture', opts),
          list: (opts: Record<string, unknown> = {}) => text('reference_list', opts),
          reveal: (opts: Record<string, unknown>) => text('reference_reveal', opts),
        },
        help: (name?: string) => name === undefined
          ? [...catalog.keys()].filter(n => n !== CODE_TOOL).map(n => n.slice(PREFIX.length)).join(', ')
          : resolve(name).description ?? '',
        sleep: (ms: number) => new Promise<void>((done, fail) => {
          const handle = setTimeout(done, Math.min(Math.max(ms, 0), 60_000))
          controller.signal.addEventListener('abort', () => { clearTimeout(handle); fail(controller.signal.reason) }, { once: true })
        }),
        log,
        console: { log, info: log, warn: log, error: log },
      }

      let ok = true
      try {
        const sandbox = { ...api, JSON, Math, Date, URL, URLSearchParams, Promise, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent }
        const body = `(async () => {\n${args.code}\n})()`
        const pending = runInNewContext(body, sandbox, { timeout: 5000, filename: 'dsh_browser_code.js' }) as Promise<unknown>
        const aborted = new Promise<never>((_, fail) => {
          if (controller.signal.aborted) fail(controller.signal.reason)
          controller.signal.addEventListener('abort', () => fail(controller.signal.reason), { once: true })
        })
        const result = await Promise.race([pending, aborted])
        if (result !== undefined) lines.push(format(result))
      } catch (error) {
        ok = false
        lines.push(`Error: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
        exec.signal?.removeEventListener('abort', onAbort)
        controller.abort()
      }
      exec.signal?.throwIfAborted()
      let output = lines.join('\n')
      if (output === '') output = ok ? 'Done (no output; return or log() what you need).' : 'Error'
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} chars]`
      return { output, ok, calls, images }
    },
  })
}
