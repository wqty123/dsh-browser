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

/** A failed `tools.*` call, named after the tool, like DSH run_code's ToolCallError. */
class ToolCallError extends Error {
  readonly toolName: string
  constructor(toolName: string, message: string) {
    super(message)
    this.name = 'ToolCallError'
    this.toolName = toolName
  }
}

/** DSH run_code-style bindings: `await tools.dsh_browser_snapshot({})` resolves to the tool's JSON value. */
const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = new Proxy(Object.create(null), {
  get: (_target, name) => typeof name !== 'string' || name === 'then' ? undefined : async (args: Record<string, unknown> = {}) => {
    try { return (await ask(name, args)).value } catch (error) { throw new ToolCallError(name, error instanceof Error ? error.message : String(error)) }
  },
})
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
const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/

function skipString(code: string, start: number): number {
  const quote = code[start]!
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]!
    if (ch === '\\') { i += 2; continue }
    if (quote === '`' && ch === '$' && code[i + 1] === '{') {
      i += 2
      let depth = 1
      while (i < code.length && depth > 0) {
        const inner = code[i]!
        if (inner === "'" || inner === '"' || inner === '`') { i = skipString(code, i); continue }
        if (inner === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i + 2); i = i === -1 ? code.length : i + 1; continue }
        if (inner === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); i = i === -1 ? code.length : i + 2; continue }
        if (inner === '{') depth++
        else if (inner === '}') depth--
        i++
      }
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return i
}

function skipWsAndComments(code: string, start: number): number {
  let i = start
  while (i < code.length) {
    const ch = code[i]!
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i + 2); i = i === -1 ? code.length : i + 1; continue }
    if (ch === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); i = i === -1 ? code.length : i + 2; continue }
    break
  }
  return i
}

function readIdent(code: string, start: number): { readonly name: string; readonly end: number } | undefined {
  if (start >= code.length || !IDENT_START.test(code[start]!)) return undefined
  let i = start + 1
  while (i < code.length && IDENT_PART.test(code[i]!)) i++
  return { name: code.slice(start, i), end: i }
}

/** Skip an initializer/default expression until an unnested stop character (`,` `;` `]` `}` or newline). */
function skipInitExpr(code: string, start: number, stopOnNewline: boolean): number {
  let i = start
  let depth = 0
  while (i < code.length) {
    const ch = code[i]!
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(code, i); continue }
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i + 2)
      i = nl === -1 ? code.length : nl
      if (stopOnNewline && depth === 0) return i
      continue
    }
    if (ch === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); i = i === -1 ? code.length : i + 2; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth--
      i++
      continue
    }
    if (depth === 0) {
      if (ch === ',' || ch === ';') return i
      if (stopOnNewline && ch === '\n') return i
    }
    i++
  }
  return i
}

/** Parse a JS binding identifier or destructuring pattern (`[a, { b: c = 1 }]`), collecting bound names. */
function parseBindingPattern(code: string, start: number, names: Set<string>): number {
  let i = skipWsAndComments(code, start)
  if (i >= code.length) return i
  const ch = code[i]!
  if (ch === '[') {
    i++
    while (i < code.length) {
      i = skipWsAndComments(code, i)
      if (code[i] === ']') return i + 1
      if (code[i] === ',') { i++; continue }
      if (code.startsWith('...', i)) i = skipWsAndComments(code, i + 3)
      const next = parseBindingPattern(code, i, names)
      if (next === i) break
      i = skipWsAndComments(code, next)
      if (code[i] === '=') i = skipInitExpr(code, i + 1, false)
      i = skipWsAndComments(code, i)
      if (code[i] === ',') i++
      else if (code[i] === ']') return i + 1
    }
    return i
  }
  if (ch === '{') {
    i++
    while (i < code.length) {
      i = skipWsAndComments(code, i)
      if (code[i] === '}') return i + 1
      if (code[i] === ',') { i++; continue }
      if (code.startsWith('...', i)) {
        const rest = readIdent(code, skipWsAndComments(code, i + 3))
        if (rest) { names.add(rest.name); i = skipWsAndComments(code, rest.end) }
        else break
      } else {
        // Property key: computed `[expr]`, string/number literal, or identifier.
        let keyIdent: string | undefined
        if (code[i] === '[') {
          i = skipInitExpr(code, i + 1, false)
          if (code[i] === ']') i++
        } else if (code[i] === "'" || code[i] === '"') {
          i = skipString(code, i)
        } else {
          const ident = readIdent(code, i)
          if (ident) { keyIdent = ident.name; i = ident.end }
          else {
            const num = /^\d+(?:\.\d+)?/.exec(code.slice(i))
            if (num) i += num[0].length
            else break
          }
        }
        i = skipWsAndComments(code, i)
        if (code[i] === ':') {
          i = parseBindingPattern(code, i + 1, names)
        } else if (keyIdent !== undefined) {
          names.add(keyIdent)
        }
        i = skipWsAndComments(code, i)
        if (code[i] === '=') i = skipInitExpr(code, i + 1, false)
      }
      i = skipWsAndComments(code, i)
      if (code[i] === ',') i++
      else if (code[i] === '}') return i + 1
    }
    return i
  }
  const ident = readIdent(code, i)
  if (ident) { names.add(ident.name); return ident.end }
  return i
}

/**
 * Lexically scan top-level declarations (const/let/var including destructuring, function, class)
 * and top-level `return` statements while ignoring comments, strings, templates and nested blocks.
 */
function collectTopLevelBindings(code: string): { readonly names: string[]; readonly hasTopReturn: boolean } {
  const names = new Set<string>()
  let hasTopReturn = false
  let depth = 0
  let i = 0
  while (i < code.length) {
    const ch = code[i]!
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(code, i); continue }
    if (ch === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i + 2); i = i === -1 ? code.length : i + 1; continue }
    if (ch === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); i = i === -1 ? code.length : i + 2; continue }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue }
    if (ch === '}' || ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); i++; continue }

    if (depth === 0 && (i === 0 || /[\s;{}]/.test(code[i - 1]!))) {
      const rest = code.slice(i)
      const fnMatch = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\b/.exec(rest)
      if (fnMatch) { names.add(fnMatch[1]!); i += fnMatch[0].length; continue }
      const clsMatch = /^class\s+([A-Za-z_$][\w$]*)\b/.exec(rest)
      if (clsMatch) { names.add(clsMatch[1]!); i += clsMatch[0].length; continue }
      const varMatch = /^(?:const|let|var)(?=\s)/.exec(rest)
      if (varMatch) {
        i += varMatch[0].length
        while (i < code.length) {
          const next = parseBindingPattern(code, i, names)
          if (next === i) break
          i = skipWsAndComments(code, next)
          if (code[i] === '=') i = skipInitExpr(code, i + 1, true)
          const after = skipWsAndComments(code, i)
          if (code[after] === ',') { i = after + 1; continue }
          i = after
          if (code[i] === ';') i++
          break
        }
        continue
      }
      if (/^return(?=$|[\s;(])/.test(rest)) { hasTopReturn = true; i += 6; continue }
    }
    i++
  }
  return { names: [...names], hasTopReturn }
}

/**
 * Make a cell behave like a REPL cell: top-level declarations (including destructuring, hoisted
 * functions and classes) persist onto `globalThis` via a same-scope `finally` saver, and a
 * trailing expression becomes the cell's return value.
 * @param code - the model's cell.
 * @returns an async function body.
 */
export function prepare(code: string): string {
  const raw = code.replace(/\s+$/, '').split('\n')
  const indent = Math.min(...raw.filter(line => line.trim() !== '').map(line => /^[ \t]*/.exec(line)?.[0].length ?? 0))
  const lines = raw.map(line => line.slice(Number.isFinite(indent) ? indent : 0))
  const body = lines.join('\n')
  const { names, hasTopReturn } = collectTopLevelBindings(body)
  // Saving through a closure defined inside the `try` block keeps `const`/`let`/`class` in the
  // same block scope (preserving hoisting and destructuring) while still persisting initialized
  // bindings on both normal return and mid-cell errors.
  const wrap = (inner: string): string => {
    if (names.length === 0) return inner
    const save = names.map(name => `try { globalThis.${name} = ${name}; } catch {}`).join(' ')
    return `let __dshSave;\ntry {\n__dshSave = () => { ${save} };\n${inner}\n} finally {\n__dshSave?.();\n}`
  }
  if (hasTopReturn) return wrap(body)
  const last = lines.length - 1
  const line = lines[last] ?? ''
  const previous = lines.slice(0, last).reverse().find(l => l.trim() !== '')?.trimEnd() ?? ''
  if (line === '' || /^\s/.test(line) || NOT_EXPRESSION.test(line) || CONTINUES.test(previous) || /[{,]$/.test(line)) {
    return wrap(body)
  }
  // A one-line cell of several statements returns its last one.
  const split = line.lastIndexOf(';', line.replace(/;\s*$/, '').length - 1)
  const head = split > 0 ? line.slice(0, split + 1) + '\n' : ''
  const tail = (split > 0 ? line.slice(split + 1) : line).trim().replace(/^;\s*/, '').replace(/;\s*$/, '')
  for (const candidate of [`${head}return (${tail})`, `return (${line.replace(/^;\s*/, '').replace(/;\s*$/, '')})`]) {
    const transformed = [...lines.slice(0, last), candidate].join('\n')
    if (tail !== '' && compiles(wrap(transformed))) return wrap(transformed)
  }
  return wrap(body)
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
  const expression = `return (${script.replace(/;\s*$/, '')})`
  const body = compiles(expression) ? expression : script
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
  scroll: async (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) return text('scroll', args[0] as Record<string, unknown>)
    if (args.length >= 3) {
      const [x, y, dy] = [Number(args[0]), Number(args[1]), Number(args[2])]
      return String(await js(`(() => {
        let el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
        while (el && el !== document.documentElement && el !== document.body) {
          const st = getComputedStyle(el);
          if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) {
            el.scrollBy({ top: ${JSON.stringify(dy)} });
            return 'Scrolled element.';
          }
          el = el.parentElement;
        }
        window.scrollBy({ top: ${JSON.stringify(dy)} });
        return 'Scrolled window.';
      })()`))
    }
    const deltaY = args.length === 1 ? Number(args[0]) : 600
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
    if (typeof input !== 'string' && typeof target !== 'string') {
      throw new Error('type(target, text): text must be a string when target is an object')
    }
    const toolArgs = typeof input === 'string' ? { ...targetArgs(target), text: input } : { text: target as string }
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

const context = createContext({ ...helpers, open: helpers.goto_url, press: helpers.press_key, tools, ToolCallError })

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
