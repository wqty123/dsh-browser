/**
 * The dsh_browser_code REPL worker: one child process per task, like Browser Use 1.0's
 * repl/worker.py. It keeps one vm context alive across calls (variables and functions survive),
 * prints the last expression, and reaches the browser only by asking the parent to run a
 * registered dsh_browser_* tool. A runaway cell is stopped by killing this process; the browser
 * and the parent are never blocked by it.
 */
import { Script, createContext, runInContext } from 'node:vm'
import { inspect } from 'node:util'

type Reply = { readonly type: 'reply'; readonly id: number; readonly value?: unknown; readonly text?: string; readonly error?: string }
type Run = { readonly type: 'run'; readonly code: string }

const send = (message: unknown): void => { process.send?.(message) }
const pending = new Map<number, { resolve: (reply: Reply) => void }>()
let seq = 0

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return inspect(value)
  try { return JSON.stringify(value) ?? String(value) } catch { return inspect(value, { depth: 4 }) }
}
const log = (...values: unknown[]): void => { send({ type: 'log', text: values.map(format).join(' ') }) }

async function ask(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const id = ++seq
  const reply = await new Promise<Reply>(resolve => { pending.set(id, { resolve }); send({ type: 'call', id, name, args }) })
  if (reply.error !== undefined) throw new Error(reply.error)
  return reply
}
const value = async (name: string, args?: Record<string, unknown>): Promise<unknown> => (await ask(name, args)).value
const text = async (name: string, args?: Record<string, unknown>): Promise<string> => (await ask(name, args)).text ?? ''

export type Target = string | { css?: string; text?: string; xpath?: string; by?: string; value?: string; index?: number; x?: number; y?: number }

const HTML_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'div', 'span', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'tbody', 'thead', 'img', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside', 'option', 'summary', 'details', 'iframe', 'body', 'svg', 'dialog'])

function looksLikeSelector(raw: string): boolean {
  if (/^[#.[]\S/.test(raw)) return true
  const tag = /^[a-z][a-z0-9-]*/.exec(raw)?.[0]
  if (tag === undefined || !HTML_TAGS.has(tag)) return false
  const rest = raw.slice(tag.length)
  return rest === '' || /^[#.[:]/.test(rest) || /^\s*>/.test(rest)
}

/**
 * Turn a helper target into click/type arguments. A string is visible text unless it reads as a
 * CSS selector or an XPath expression.
 * @param target - text, selector, {css|text|xpath, index}, {by, value} or {x, y}.
 */
export function targetArgs(target: Target): Record<string, unknown> {
  if (typeof target === 'string') {
    if (target.startsWith('//') || target.startsWith('(//')) return { target: { by: 'xpath', value: target } }
    return { target: { by: looksLikeSelector(target) ? 'css' : 'text', value: target } }
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

const NOT_EXPRESSION = /^(return|if|for|while|do|switch|try|catch|finally|throw|const|let|var|function|async\s+function|class|import|export|break|continue|else|\}|\)|\]|\/\/|\/\*|\*)/
const CONTINUES = /[([{,+\-*/%=&|?:.<>!^~]$|=>$/

/**
 * Make a cell behave like a REPL cell: top-level declarations land on the context (so they
 * survive the call) and a trailing expression is the cell's value.
 * @param code - the model's cell.
 * @returns an async function body.
 */
export function prepare(code: string): string {
  const raw = code.replace(/\s+$/, '').split('\n')
  const indent = Math.min(...raw.filter(line => line.trim() !== '').map(line => /^[ \t]*/.exec(line)?.[0].length ?? 0))
  const lines = raw.map(line => line.slice(Number.isFinite(indent) ? indent : 0)
    .replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'globalThis.$1 =')
    .replace(/^(async\s+)?function(\s*\*?\s*)([A-Za-z_$][\w$]*)/, 'globalThis.$3 = $1function$2$3')
    .replace(/^class\s+([A-Za-z_$][\w$]*)/, 'globalThis.$1 = class $1'))
  const body = lines.join('\n')
  if (lines.some(line => /^return\b/.test(line))) return body
  const last = lines.length - 1
  const line = lines[last] ?? ''
  const previous = lines.slice(0, last).reverse().find(l => l.trim() !== '')?.trimEnd() ?? ''
  if (line === '' || /^\s/.test(line) || NOT_EXPRESSION.test(line) || line.startsWith('globalThis.') || CONTINUES.test(previous) || /[{,]$/.test(line)) return body
  // A one-line cell of several statements returns its last one.
  const split = line.lastIndexOf(';', line.replace(/;\s*$/, '').length - 1)
  const head = split > 0 ? line.slice(0, split + 1) + '\n' : ''
  const tail = (split > 0 ? line.slice(split + 1) : line).trim().replace(/^;\s*/, '').replace(/;\s*$/, '')
  for (const candidate of [`${head}return (${tail})`, `return (${line.replace(/^;\s*/, '').replace(/;\s*$/, '')})`]) {
    const transformed = [...lines.slice(0, last), candidate].join('\n')
    if (tail !== '' && compiles(transformed)) return transformed
  }
  return body
}

function compiles(body: string): boolean {
  try { new Script(`(async () => {\n${body}\n})`); return true } catch { return false }
}

/**
 * Wrap a page expression so its value comes back as JSON text that keeps strings strings and
 * numbers exact; a script with a top-level `return` runs as a function body.
 * @param script - an expression, or statements with `return`.
 */
function pageScript(script: string): string {
  const body = /(^|[;\n{}])\s*return\b/.test(script) ? script : `return (${script.replace(/;\s*$/, '')})`
  return `(async () => { const v = await (async () => {\n${body}\n})(); return JSON.stringify(v === undefined ? null : v) })()`
}

const helpers = {
  // Browser Use 1.0 / browser-harness names.
  goto_url: (url: string) => text('open', { url }),
  new_tab: (url: string) => text('open', { url, newTab: true }),
  wait_for_load: async (timeoutMs?: number) => {
    const out = await value('wait', timeoutMs !== undefined ? { timeoutMs } : {}) as { ready: boolean; reason: string }
    if (!out.ready) throw new Error(`page did not finish loading: ${out.reason}`)
    return true
  },
  page_info: () => js('({ url: location.href, title: document.title, w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, pw: document.documentElement.scrollWidth, ph: document.documentElement.scrollHeight })'),
  list_tabs: () => value('list_tabs'),
  switch_tab: (tabId: string) => text('switch_tab', { tabId }),
  close_tab: (tabId: string) => text('close_tab', { tabId }),
  js: (script: string) => js(script),
  click_at_xy: (x: number, y: number) => text('click', { x, y }),
  type_text: (input: string) => text('type', { text: input }),
  fill_input: (target: Target, input: string) => text('set_value', { ...targetArgs(target), value: input }),
  press_key: (key: string) => text('key', { key }),
  scroll: (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) return text('scroll', args[0] as Record<string, unknown>)
    const deltaY = args.length >= 3 ? Number(args[2]) : args.length === 1 ? Number(args[0]) : 600
    return text('scroll', { deltaY })
  },
  screenshot: (opts: Record<string, unknown> = {}) => text('screenshot', opts),
  wait_for_element: async (selector: string, timeoutMs?: number) => {
    const out = await value('wait', { selector, ...timeoutMs !== undefined ? { timeoutMs } : {} }) as { ready: boolean; reason: string }
    if (!out.ready) throw new Error(`wait_for_element: ${out.reason}`)
    return true
  },
  wait_for_network_idle: async (timeoutMs?: number) => {
    const out = await value('do', { steps: [{ wait_idle: {} }], ...timeoutMs !== undefined ? { timeoutMs } : {} }) as { ok: boolean; reason?: string }
    if (!out.ok) throw new Error(`wait_for_network_idle: ${out.reason ?? 'not idle'}`)
    return true
  },
  upload_file: (selector: string, path: string) => text('upload', { target: { by: 'css', value: selector }, path }),
  // Semantic helpers over the dsh tools.
  click: (target: Target) => text('click', targetArgs(target)),
  type: async (target: Target, input?: string | { submit?: boolean }, opts: { submit?: boolean } = {}) => {
    const toolArgs = typeof input === 'string' ? { ...targetArgs(target), text: input } : { text: String(target) }
    if (typeof input === 'object' && input !== null) opts = input
    let out = await text('type', toolArgs)
    if (opts.submit === true) out += '\n' + await text('key', { key: 'Enter' })
    return out
  },
  select: (target: Target, optionText: string) => text('select', { ...targetArgs(target), optionText }),
  fill: async (fields: readonly Record<string, unknown>[], opts: { submit?: boolean } = {}) => {
    const out = await value('fill', { fields, ...opts.submit === true ? { submit: true } : {} }) as { fields: { ok: boolean; target?: string; error?: string }[]; submitted?: boolean }
    const failed = out.fields.filter(field => !field.ok)
    if (failed.length > 0) throw new Error(`fill: ${failed.length} field(s) failed: ${failed.map(field => `${field.target ?? '?'}: ${field.error ?? 'failed'}`).join('; ')}`)
    return out
  },
  back: () => text('back'),
  forward: () => text('forward'),
  refresh: () => text('refresh'),
  read: async (opts: Record<string, unknown> = {}) => {
    const out = await value('content', { format: 'markdown', maxChars: 20000, ...opts }) as { content?: string; truncated?: boolean }
    return (out.content ?? '') + (out.truncated === true ? '\n[truncated; pass selector or maxChars]' : '')
  },
  snapshot: (opts: Record<string, unknown> = {}) => text('snapshot', opts),
  find: (needle: string, opts: Record<string, unknown> = {}) => text('find', { text: needle, ...opts }),
  state: () => text('state'),
  refs: {
    capture: (opts: Record<string, unknown> = {}) => text('reference_capture', opts),
    list: (opts: Record<string, unknown> = {}) => text('reference_list', opts),
    reveal: (opts: Record<string, unknown>) => text('reference_reveal', opts),
  },
  call: (name: string, args: Record<string, unknown> = {}) => value(name, args),
  help: (name?: string) => value('__help', name === undefined ? {} : { name }),
  sleep: (ms: number) => new Promise<void>(done => setTimeout(done, Math.min(Math.max(Number(ms) || 0, 0), 60_000))),
  print: log,
  log,
  console: { log, info: log, warn: log, error: log, debug: log },
}

async function js(script: string): Promise<unknown> {
  const out = await value('execute', { script: pageScript(script) }) as { ok: boolean; value?: string; exception?: string }
  if (!out.ok) throw new Error(`js: ${out.exception ?? 'page script failed'}`)
  return out.value === undefined ? undefined : JSON.parse(out.value)
}

const context = createContext({ ...helpers, open: helpers.goto_url, press: helpers.press_key })

process.on('message', (message: Reply | Run) => {
  if (message.type === 'reply') {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    entry?.resolve(message)
    return
  }
  if (message.type === 'run') {
    void (async () => {
      try {
        const result = await (runInContext(`(async () => {\n${prepare(message.code)}\n})()`, context, { filename: 'cell.js' }) as Promise<unknown>)
        if (result !== undefined) log(result)
        send({ type: 'done', ok: true })
      } catch (error) {
        send({ type: 'done', ok: false, error: error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error) })
      }
    })()
  }
})
process.on('disconnect', () => process.exit(0))
send({ type: 'ready' })
