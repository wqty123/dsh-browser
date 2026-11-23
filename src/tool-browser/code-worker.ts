/**
 * The dsh_browser_code REPL worker: one child process per task, like Browser Use 1.0's
 * repl/worker.py. It keeps one vm context alive across calls (variables and functions survive),
 * prints the last expression, and reaches the browser only by asking the parent to run a
 * registered dsh_browser_* tool. A runaway cell is stopped by killing this process; the browser
 * and the parent are never blocked by it.
 */
import { Script, createContext, runInContext } from 'node:vm'
import { inspect } from 'node:util'

type Reply = { readonly type: 'reply'; readonly id: number; readonly value?: unknown; readonly text?: string; readonly error?: string; readonly code?: string }
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

/** A failed browser tool call (a helper or `tools.*`), named after the tool, like DSH run_code's ToolCallError. */
class ToolCallError extends Error {
  readonly toolName: string
  readonly code: string | undefined
  constructor(toolName: string, message: string, code?: string) {
    super(message)
    this.name = 'ToolCallError'
    this.toolName = toolName
    this.code = code
  }
}

async function ask(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const id = ++seq
  const reply = await new Promise<Reply>(resolve => { pending.set(id, { resolve }); send({ type: 'call', id, name, args }) })
  if (reply.error !== undefined) {
    if (name.startsWith('__')) throw new Error(reply.error)
    throw new ToolCallError(name.startsWith('dsh_browser_') ? name : `dsh_browser_${name}`, reply.error, reply.code)
  }
  return reply
}
const value = async (name: string, args?: Record<string, unknown>): Promise<unknown> => (await ask(name, args)).value

/** DSH run_code-style bindings: `await tools.dsh_browser_snapshot({})` resolves to the tool's JSON value. */
const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = new Proxy(Object.create(null), {
  get: (_target, name) => typeof name !== 'string' || name === 'then' ? undefined : (args: Record<string, unknown> = {}) => value(name, args),
})
interface TabRow { readonly id: string; readonly url: string; readonly active: boolean }
/** The task's tabs, read without a trace entry (wait_for_new_tab polls this). */
const tabs = async (): Promise<readonly TabRow[]> => ((await value('__tabs')) as { tabs?: readonly TabRow[] }).tabs ?? []
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
const REGEX_BEFORE = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>', '\n'])
const REGEX_KEYWORDS = new Set(['return', 'throw', 'case', 'in', 'instanceof', 'typeof', 'void', 'delete', 'new', 'await', 'yield', 'else', 'do', 'of'])

interface ScanResult {
  readonly rewritten: string
  readonly varNames: readonly string[]
  readonly fnNames: readonly string[]
  readonly hasTopReturn: boolean
}

/**
 * Dedent top-level lines while leaving multiline template literal bodies untouched, so unindented
 * lines inside a template literal do not prevent dedenting the surrounding cell (and trailing
 * parenthesized expressions still get turned into `return (...)` instead of triggering ASI calls).
 */
function dedentTopLevel(code: string): { readonly dedented: string; readonly inTemplateStart: readonly boolean[] } {
  const trimmed = code.replace(/\s+$/, '')
  const lines = trimmed.split('\n')
  const inTemplateStart = new Array<boolean>(lines.length).fill(false)
  let lineIdx = 0
  let i = 0
  let prevChar = ''
  let prevWord = ''
  const n = trimmed.length

  const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch)
  const isIdentPart = (ch: string): boolean => /[\w$]/.test(ch)
  const advance = (ch: string): void => { if (ch === '\n') lineIdx++ }

  const skipRegex = (): void => {
    i++
    let inClass = false
    while (i < n) {
      const ch = trimmed[i]!
      if (ch === '\\') { advance(trimmed[i + 1] ?? ''); i += 2; continue }
      if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) {
        i++
        while (i < n && /[a-z]/i.test(trimmed[i]!)) i++
        return
      } else if (ch === '\n') return
      i++
    }
  }

  const skipQuoted = (quote: string): void => {
    i++
    while (i < n) {
      const ch = trimmed[i]!
      if (ch === '\\') { advance(trimmed[i + 1] ?? ''); i += 2; continue }
      if (quote === '`' && ch === '$' && trimmed[i + 1] === '{') {
        i += 2
        let exprDepth = 1
        let exprPrev = '{'
        let exprWord = ''
        while (i < n && exprDepth > 0) {
          const c = trimmed[i]!
          if (c === "'" || c === '"' || c === '`') { skipQuoted(c); exprPrev = '"'; exprWord = ''; continue }
          if (c === '/' && trimmed[i + 1] === '/') { while (i < n && trimmed[i] !== '\n') i++; continue }
          if (c === '/' && trimmed[i + 1] === '*') {
            i += 2
            while (i < n && !(trimmed[i] === '*' && trimmed[i + 1] === '/')) { advance(trimmed[i]!); i++ }
            if (i < n) i += 2
            continue
          }
          if (c === '/' && (REGEX_BEFORE.has(exprPrev) || REGEX_KEYWORDS.has(exprWord))) { skipRegex(); exprPrev = '/'; exprWord = ''; continue }
          if (isIdentStart(c)) {
            const start = i
            i++
            while (i < n && isIdentPart(trimmed[i]!)) i++
            exprPrev = 'a'; exprWord = trimmed.slice(start, i)
            continue
          }
          if (c === '{') exprDepth++
          else if (c === '}') exprDepth--
          if (c === '\n') { lineIdx++; exprPrev = '\n'; exprWord = '' }
          else if (!/\s/.test(c)) { exprPrev = c; exprWord = '' }
          i++
        }
        continue
      }
      if (ch === quote) { i++; return }
      if (ch === '\n') {
        lineIdx++
        if (quote === '`' && lineIdx < lines.length) inTemplateStart[lineIdx] = true
      }
      i++
    }
  }

  while (i < n) {
    const ch = trimmed[i]!
    if (ch === "'" || ch === '"' || ch === '`') { skipQuoted(ch); prevChar = '"'; prevWord = ''; continue }
    if (ch === '/' && trimmed[i + 1] === '/') { while (i < n && trimmed[i] !== '\n') i++; continue }
    if (ch === '/' && trimmed[i + 1] === '*') {
      i += 2
      while (i < n && !(trimmed[i] === '*' && trimmed[i + 1] === '/')) { advance(trimmed[i]!); i++ }
      if (i < n) i += 2
      continue
    }
    if (ch === '/' && (REGEX_BEFORE.has(prevChar) || REGEX_KEYWORDS.has(prevWord))) { skipRegex(); prevChar = '/'; prevWord = ''; continue }
    if (isIdentStart(ch)) {
      const start = i
      i++
      while (i < n && isIdentPart(trimmed[i]!)) i++
      prevChar = 'a'; prevWord = trimmed.slice(start, i)
      continue
    }
    if (ch === '\n') { lineIdx++; prevChar = '\n'; prevWord = '' }
    else if (!/\s/.test(ch)) { prevChar = ch; prevWord = '' }
    i++
  }

  const indents = lines
    .filter((line, idx) => !inTemplateStart[idx] && line.trim() !== '')
    .map(line => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  const dedented = indent === 0
    ? trimmed
    : lines.map((line, idx) => inTemplateStart[idx] ? line : line.slice(indent)).join('\n')
  return { dedented, inTemplateStart }
}

/**
 * Lexically scan top-level declarations (skipping comments, strings, nested template literals,
 * regex literals and nested blocks) so destructuring, multiline template strings and hoisted
 * functions all persist cleanly across REPL cells.
 */
function scanTopLevel(code: string): ScanResult {
  const varNames = new Set<string>()
  const fnNames = new Set<string>()
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] = []
  let hasTopReturn = false
  let depth = 0
  let i = 0
  let prevChar = ''
  let prevWord = ''
  const n = code.length

  const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch)
  const isIdentPart = (ch: string): boolean => /[\w$]/.test(ch)

  const skipSpacesAndComments = (allowNewline = true): void => {
    while (i < n) {
      const ch = code[i]!
      if (ch === ' ' || ch === '\t' || ch === '\r' || (allowNewline && ch === '\n')) { i++; continue }
      if (ch === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue }
      if (ch === '/' && code[i + 1] === '*') {
        const end = code.indexOf('*/', i + 2)
        i = end === -1 ? n : end + 2
        continue
      }
      break
    }
  }

  const skipQuoted = (quote: string): void => {
    i++
    while (i < n) {
      const ch = code[i]!
      if (ch === '\\') { i += 2; continue }
      if (quote === '`' && ch === '$' && code[i + 1] === '{') {
        i += 2
        let exprDepth = 1
        while (i < n && exprDepth > 0) {
          const c = code[i]!
          if (c === "'" || c === '"' || c === '`') skipQuoted(c)
          else if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++ }
          else if (c === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); i = end === -1 ? n : end + 2 }
          else { if (c === '{') exprDepth++; else if (c === '}') exprDepth--; i++ }
        }
        continue
      }
      if (ch === quote) { i++; return }
      i++
    }
  }

  const skipRegex = (): void => {
    i++
    let inClass = false
    while (i < n) {
      const ch = code[i]!
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) {
        i++
        while (i < n && /[a-z]/i.test(code[i]!)) i++
        return
      } else if (ch === '\n') return
      i++
    }
  }

  const readIdent = (): string | undefined => {
    if (i >= n || !isIdentStart(code[i]!)) return undefined
    const start = i
    i++
    while (i < n && isIdentPart(code[i]!)) i++
    return code.slice(start, i)
  }

  const skipBalancedExpr = (stopChars: string): void => {
    let exprDepth = 0
    let localPrev = '='
    let localWord = ''
    while (i < n) {
      const ch = code[i]!
      if (ch === "'" || ch === '"' || ch === '`') { skipQuoted(ch); localPrev = '"'; localWord = ''; continue }
      if (ch === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue }
      if (ch === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue }
      if (ch === '/' && (REGEX_BEFORE.has(localPrev) || REGEX_KEYWORDS.has(localWord))) { skipRegex(); localPrev = '/'; localWord = ''; continue }
      if (ch === '(' || ch === '[' || ch === '{') { exprDepth++; i++; localPrev = ch; localWord = ''; continue }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (exprDepth === 0 && stopChars.includes(ch)) return
        exprDepth = Math.max(0, exprDepth - 1); i++; localPrev = ch; localWord = ''; continue
      }
      if (exprDepth === 0 && stopChars.includes(ch)) return
      if (isIdentStart(ch)) {
        const w = readIdent() ?? ''
        localPrev = 'a'; localWord = w; continue
      }
      if (!/\s/.test(ch)) { localPrev = ch; localWord = '' }
      else if (ch === '\n' && exprDepth === 0 && stopChars.includes('\n')) return
      i++
    }
  }

  const parseBindingPattern = (): void => {
    skipSpacesAndComments()
    if (i >= n) return
    if (code.startsWith('...', i)) {
      i += 3
      skipSpacesAndComments()
      const name = readIdent()
      if (name !== undefined) varNames.add(name)
      return
    }
    if (code[i] === '[') {
      i++
      while (i < n) {
        skipSpacesAndComments()
        if (code[i] === ']') { i++; return }
        if (code[i] === ',') { i++; continue }
        parseBindingPattern()
        skipSpacesAndComments()
        if (code[i] === '=') { i++; skipBalancedExpr(',]') }
        skipSpacesAndComments()
        if (code[i] === ',') i++
        else if (code[i] === ']') { i++; return }
        else break
      }
      return
    }
    if (code[i] === '{') {
      i++
      while (i < n) {
        skipSpacesAndComments()
        if (code[i] === '}') { i++; return }
        if (code.startsWith('...', i)) {
          i += 3
          skipSpacesAndComments()
          const rest = readIdent()
          if (rest !== undefined) varNames.add(rest)
        } else {
          let keyIdent: string | undefined
          if (code[i] === '[') {
            i++; skipBalancedExpr(']'); if (code[i] === ']') i++
          } else if (code[i] === "'" || code[i] === '"') {
            skipQuoted(code[i]!)
          } else if (isIdentStart(code[i]!)) {
            keyIdent = readIdent()
          } else {
            while (i < n && !/[\s:,=}]/.test(code[i]!)) i++
          }
          skipSpacesAndComments()
          if (code[i] === ':') {
            i++
            parseBindingPattern()
          } else if (keyIdent !== undefined) {
            varNames.add(keyIdent)
          }
        }
        skipSpacesAndComments()
        if (code[i] === '=') { i++; skipBalancedExpr(',}') }
        skipSpacesAndComments()
        if (code[i] === ',') i++
        else if (code[i] === '}') { i++; return }
        else break
      }
      return
    }
    const name = readIdent()
    if (name !== undefined) varNames.add(name)
  }

  while (i < n) {
    const ch = code[i]!
    if (ch === "'" || ch === '"' || ch === '`') { skipQuoted(ch); prevChar = '"'; prevWord = ''; continue }
    if (ch === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue }
    if (ch === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue }
    if (ch === '/' && (REGEX_BEFORE.has(prevChar) || REGEX_KEYWORDS.has(prevWord))) { skipRegex(); prevChar = '/'; prevWord = ''; continue }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; prevChar = ch; prevWord = ''; continue }
    if (ch === '}' || ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); i++; prevChar = ch; prevWord = ''; continue }

    if (depth === 0 && isIdentStart(ch) && prevChar !== '.') {
      const wordStart = i
      const word = readIdent()!
      if (word === 'const' || word === 'let' || word === 'var') {
        if (word !== 'var') replacements.push({ start: wordStart, end: i, text: 'var' })
        while (i < n) {
          parseBindingPattern()
          skipSpacesAndComments(false)
          if (code[i] === '=') {
            i++
            skipSpacesAndComments(true)
            skipBalancedExpr(',;\n')
          }
          skipSpacesAndComments(false)
          if (code[i] === ',') { i++; continue }
          break
        }
        prevChar = 'a'; prevWord = ''
        continue
      }
      if (word === 'async') {
        const saved = i
        skipSpacesAndComments(false)
        if (code.startsWith('function', i) && !isIdentPart(code[i + 8] ?? '')) {
          i += 8
          skipSpacesAndComments()
          if (code[i] === '*') { i++; skipSpacesAndComments() }
          const fn = readIdent()
          if (fn !== undefined) fnNames.add(fn)
          prevChar = 'a'; prevWord = 'function'
          continue
        }
        i = saved
      }
      if (word === 'function') {
        skipSpacesAndComments()
        if (code[i] === '*') { i++; skipSpacesAndComments() }
        const fn = readIdent()
        if (fn !== undefined) fnNames.add(fn)
        prevChar = 'a'; prevWord = 'function'
        continue
      }
      if (word === 'class') {
        skipSpacesAndComments()
        const cls = readIdent()
        if (cls !== undefined) {
          varNames.add(cls)
          replacements.push({ start: wordStart, end: wordStart + 5, text: `var ${cls} = class` })
        }
        prevChar = 'a'; prevWord = 'class'
        continue
      }
      if (word === 'return') hasTopReturn = true
      prevChar = 'a'; prevWord = word
      continue
    }

    if (ch === '\n') { prevChar = '\n'; prevWord = '' }
    else if (!/\s/.test(ch)) { prevChar = ch; prevWord = '' }
    i++
  }

  let rewritten = code
  for (let idx = replacements.length - 1; idx >= 0; idx--) {
    const rep = replacements[idx]!
    rewritten = rewritten.slice(0, rep.start) + rep.text + rewritten.slice(rep.end)
  }
  return { rewritten, varNames: [...varNames], fnNames: [...fnNames], hasTopReturn }
}

/**
 * Make a cell behave like a REPL cell: top-level declarations land on the context (so they
 * survive the call) and a trailing expression is the cell's value.
 * @param code - the model's cell.
 * @returns an async function body.
 */
export function prepare(code: string): string {
  const { dedented, inTemplateStart } = dedentTopLevel(code)
  const { rewritten, varNames, fnNames, hasTopReturn } = scanTopLevel(dedented)
  const prelude = fnNames.length === 0 ? '' : fnNames.map(name => `globalThis.${name} = ${name};`).join(' ') + '\n'
  const persist = varNames.length === 0
    ? ''
    : varNames.map(name => `try { if (typeof ${name} !== 'undefined' || !(${JSON.stringify(name)} in globalThis)) globalThis.${name} = ${name}; } catch {}`).join(' ')
  const wrap = (body: string): string => {
    if (persist !== '') return `try {\n${prelude}${body}\n} finally {\n${persist}\n}`
    return `${prelude}${body}`
  }

  if (hasTopReturn) return wrap(rewritten)
  const lines = rewritten.split('\n')
  const last = lines.length - 1
  const line = lines[last] ?? ''
  const previous = lines.slice(0, last).reverse().find(l => l.trim() !== '')?.trimEnd() ?? ''
  if (inTemplateStart[last] || line === '' || /^\s/.test(line) || NOT_EXPRESSION.test(line) || CONTINUES.test(previous) || /[{,]$/.test(line)) {
    return wrap(rewritten)
  }
  // A one-line cell of several statements returns its last one.
  const split = line.lastIndexOf(';', line.replace(/;\s*$/, '').length - 1)
  const head = split > 0 ? line.slice(0, split + 1) + '\n' : ''
  const tail = (split > 0 ? line.slice(split + 1) : line).trim().replace(/^;\s*/, '').replace(/;\s*$/, '')
  for (const candidate of [`${head}return (${tail})`, `return (${line.replace(/^;\s*/, '').replace(/;\s*$/, '')})`]) {
    const transformed = [...lines.slice(0, last), candidate].join('\n')
    if (tail !== '' && compiles(wrap(transformed))) return wrap(transformed)
  }
  return wrap(rewritten)
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
  wait_for_new_tab: async (trigger?: (() => unknown) | number, timeoutMs?: number): Promise<TabRow> => {
    const budget = typeof trigger === 'number' ? trigger : timeoutMs ?? 10_000
    const known = new Set((await tabs()).map(tab => tab.id))
    if (typeof trigger === 'function') await trigger()
    const deadline = Date.now() + Math.min(Math.max(Number(budget) || 0, 0), 600_000)
    for (;;) {
      const fresh = (await tabs()).filter(tab => !known.has(tab.id))
      if (fresh.length > 0) return fresh[fresh.length - 1]!
      if (Date.now() >= deadline) throw new Error(`no new tab opened within ${budget}ms`)
      await new Promise<void>(done => setTimeout(done, 150))
    }
  },
  with_tab: async <T>(tabId: string, fn: () => T | Promise<T>): Promise<T> => {
    if (typeof fn !== 'function') throw new TypeError('with_tab(tabId, fn) needs a function')
    const previous = (await tabs()).find(tab => tab.active)?.id
    if (previous !== tabId) await text('switch_tab', { tabId })
    try {
      return await fn()
    } finally {
      const now = await tabs()
      if (previous !== undefined && now.find(tab => tab.active)?.id !== previous && now.some(tab => tab.id === previous)) await text('switch_tab', { tabId: previous })
    }
  },
  js: (script: string) => js(script),
  click_at_xy: (x: number, y: number) => text('click', { x, y }),
  type_text: (input: string) => text('type', { text: input }),
  fill_input: (target: Target, input: string) => text('set_value', { ...targetArgs(target), value: input }),
  press_key: (key: string) => text('key', { key }),
  scroll: async (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) return text('scroll', args[0] as Record<string, unknown>)
    if (args.length >= 3) {
      const [x, y, dy] = [Number(args[0]), Number(args[1]), Number(args[2])]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dy)) {
        throw new Error('scroll(x, y, dy): coordinates and deltaY must be finite numbers')
      }
      return await js(`(() => {
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
      })()`)
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

/** How a cell's uncaught error reads in the output: a tool failure names its tool. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error instanceof ToolCallError) return `ToolCallError (${error.toolName}): ${error.message}`
  return `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`
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
        send({ type: 'done', ok: false, error: describe(error) })
      }
    })()
  }
})
process.on('disconnect', () => process.exit(0))
send({ type: 'ready' })
