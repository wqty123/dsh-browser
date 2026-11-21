// dsh_browser_code is the model's whole browser surface: one script batches many actions, and
// every helper goes through the same registered tool (gates, sessions, rendering) as before.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'
import { targetArgs, prepare } from '../lib/tool-browser/code-worker.js'

function mount(overrides = {}, config = {}, services = {}) {
  const tools = new Map()
  const options = new Map()
  const calls = []
  const sections = []
  const disposers = []
  after(() => { for (const dispose of disposers) dispose?.() })
  const record = (name, result) => async (...args) => { calls.push([name, args[1]]); return typeof result === 'function' ? result(...args) : result }
  const browser = {
    open: async () => 'session-1',
    exists: () => true,
    close: async () => {},
    openUrl: record('openUrl', undefined),
    snapshot: async () => ({ url: 'https://example.test/', title: 'Example', truncated: false, elements: [{ ref: 1, kind: 'button', label: 'Go', selector: '#go', x: 1, y: 2 }] }),
    click: record('click', { clicked: true }),
    type: record('type', { typed: true }),
    key: record('key', { pressed: true }),
    content: record('content', { content: '# Example\nHello', truncated: false }),
    execute: record('execute', (_session, request) => ({ ok: true, value: JSON.stringify({ script: request.script ?? request }) })),
    ...overrides,
  }
  apply({
    tools: { register: (tool, opts) => { tools.set(tool.name, tool); if (opts) options.set(tool.name, opts) } },
    systemPrompt: { section: section => { sections.push(section) } },
    effect: fn => { disposers.push(fn()) },
    get: name => name === 'browser' ? browser : services[name],
  }, config)
  const exec = { agent: { id: 'code-owner' } }
  const run = code => tools.get('dsh_browser_code').execute({ code }, exec)
  return { tools, options, calls, sections, run, exec }
}

test('the default surface is the core tools, the loader and the code tool', async () => {
  const { tools, exec } = mount()
  for (const name of ['dsh_browser_open', 'dsh_browser_click', 'dsh_browser_do', 'dsh_browser_reference_capture', 'dsh_browser_request_takeover', 'dsh_browser_code', 'dsh_browser_load_tools']) assert.ok(tools.has(name), name)
  assert.equal(tools.has('dsh_browser_network'), false)
  const value = await tools.get('dsh_browser_load_tools').execute({ groups: ['debug'] }, exec)
  assert.ok(value.loaded.includes('dsh_browser_network') && tools.has('dsh_browser_network'))
  assert.deepEqual((await tools.get('dsh_browser_load_tools').execute({ groups: ['debug'] }, exec)).loaded, [])
  const more = await tools.get('dsh_browser_load_tools').execute({ groups: ['forms', 'navigation', 'session', 'more'] }, exec)
  assert.ok(more.available.length > 0)
  const { tools: all } = mount({}, { surface: 'tools' })
  for (const name of all.keys()) assert.ok(tools.has(name), `${name} is reachable by loading a group`)
  await assert.rejects(tools.get('dsh_browser_load_tools').execute({ groups: ['nope'] }, exec), /must be one of|unknown tool group/)
})

test('the code tool steps aside when DSH runs in PTC mode', () => {
  assert.equal(mount().options.get('dsh_browser_code').when(), true)
  assert.equal(mount({}, {}, { ptcRuntime: {} }).options.get('dsh_browser_code').when(), false)
})

test('tools.* bindings return JSON values, overlap safe reads and keep actions in order', async () => {
  let active = 0
  let peak = 0
  const order = []
  const slow = name => async () => { active++; peak = Math.max(peak, active); order.push(`${name}:start`); await new Promise(r => setTimeout(r, 30)); active--; order.push(`${name}:end`); return { content: name, truncated: false } }
  const { run } = mount({ content: slow('content'), click: async () => { order.push('click'); return { clicked: true } } })
  const value = await run(`
    await tools.dsh_browser_open({ url: 'https://example.test/', surface: 'builtin' })
    const [a, b] = await Promise.all([tools.dsh_browser_content({ format: 'markdown' }), tools.dsh_browser_content({ format: 'markdown' })])
    let failed
    try { await tools.dsh_browser_nope({}) } catch (e) { failed = e.name + ':' + e.toolName }
    ({ a: typeof a, failed })
  `)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /"a":"object"/)
  assert.match(value.output, /ToolCallError:dsh_browser_nope/)
  assert.equal(peak, 2)
})

test('the code surface keeps only the code tool plus human takeover', () => {
  const { tools, sections } = mount({}, { surface: 'code' })
  assert.deepEqual([...tools.keys()].sort(), ['dsh_browser_code', 'dsh_browser_request_takeover'])
  assert.doesNotMatch(tools.get('dsh_browser_code').description, /\d{4}-\d{2}-\d{2}/, 'static description keeps the prompt prefix cacheable')
  const guide = sections.find(section => section.name === 'tool:dsh-builtin-browser')
  assert.match(guide.text, /dsh_browser_code/)
  assert.ok(sections.some(section => section.name === 'tool:browser-human-takeover'))
  assert.ok(sections.some(section => section.name === 'tool:dsh-browser-reference-presentation'))
})

test('the tools surface still registers every action as its own tool', () => {
  const { tools } = mount({}, { surface: 'tools' })
  assert.ok(tools.has('dsh_browser_click') && tools.has('dsh_browser_reference_capture'))
  assert.equal(tools.has('dsh_browser_code'), false)
})

test('one code call batches open, click, type, press, read and js', async () => {
  const { calls, run } = mount()
  const value = await run(`
    await call('open', { url: 'https://example.test/', surface: 'builtin' })
    await click('Sign in')
    await type('#q', 'hello', { submit: true })
    const page = await read()
    const data = await js('1 + 1')
    print('read', page.split('\\n')[0])
    ({ data })
  `)
  assert.equal(value.ok, true, value.output)
  assert.equal(value.calls, 6)
  // Action tools also probe the page through execute to verify effects; the order of the actions is what matters.
  assert.deepEqual(calls.map(([name]) => name).filter(name => name !== 'execute'), ['openUrl', 'click', 'type', 'key', 'content'])
  assert.deepEqual(calls.find(([name]) => name === 'click')[1].target, { by: 'text', value: 'Sign in' })
  assert.match(calls.at(-1)[1].script, /return \(1 \+ 1\)/)
  assert.match(value.output, /read # Example/)
  assert.match(value.output, /"data"/)
})

test('a failing helper stops the script and keeps what was logged', async () => {
  const { run } = mount({ click: async () => { throw new Error('element not found') } })
  await run(`await call('open', { url: 'https://example.test/', surface: 'builtin' })`)
  const value = await run(`print('before'); await click('#missing'); print('after')`)
  assert.equal(value.ok, false)
  assert.match(value.output, /before\nError: .*element not found/)
  assert.doesNotMatch(value.output, /after/)
})

test('call() reaches any action, and the allow-list still applies inside code', async () => {
  const { run } = mount({}, { allowedActions: ['dsh_browser_open'] })
  const open = await run(`return await call('open', { url: 'https://example.test/', surface: 'builtin' })`)
  assert.equal(open.ok, true, open.output)
  const refused = await run(`await click('Buy')`)
  assert.equal(refused.ok, false)
  assert.match(refused.output, /restricted by the plugin configuration/)
  const unknown = await run(`await call('teleport')`)
  assert.match(unknown.output, /unknown browser action "teleport"/)
})

test('the REPL keeps variables across calls and prints the last expression', async () => {
  const { run } = mount()
  assert.equal((await run('const items = [1, 2, 3]\nfunction double(x) { return x * 2 }')).ok, true)
  const value = await run('items.map(double)')
  assert.equal(value.ok, true, value.output)
  assert.equal(value.output, '[2,4,6]')
})

test('a cell past its deadline is killed, even a busy loop after await, and the REPL restarts', async () => {
  const { tools } = mount()
  const code = tools.get('dsh_browser_code')
  const exec = { agent: { id: 'deadline-owner' } }
  await code.execute({ code: 'const kept = 1' }, exec)
  const started = Date.now()
  const value = await code.execute({ code: 'await sleep(10)\nwhile (true) {}', timeoutMs: 1000 }, exec)
  assert.ok(Date.now() - started < 5000, 'the host event loop stayed free')
  assert.equal(value.ok, false)
  assert.match(value.output, /exceeded its 1000ms deadline; the REPL was restarted/)
  const after = await code.execute({ code: 'typeof kept' }, exec)
  assert.equal(after.output, 'undefined')
})

test('an already cancelled call runs no browser action', async () => {
  const { tools, calls } = mount()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tools.get('dsh_browser_code').execute({ code: "await click('Buy')" }, { agent: { id: 'code-owner' }, signal: controller.signal }))
  assert.equal(calls.some(([name]) => name === 'click'), false)
})

test('fill throws when a field fails, so later steps do not run', async () => {
  const { run } = mount({ fillForm: async () => ({ fields: [{ ok: false, target: '#email', error: 'not found' }], submitted: false }) })
  await run(`await call('open', { url: 'https://example.test/', surface: 'builtin' })`)
  const value = await run(`await fill([{ selector: '#email', value: 'a@b.c' }])\nprint('submitted')`)
  assert.equal(value.ok, false)
  assert.match(value.output, /fill: 1 field\(s\) failed: #email: not found/)
  assert.doesNotMatch(value.output, /submitted/)
})

test('js() returns page strings exactly, even when they look like JSON numbers', async () => {
  const { run } = mount({ execute: async () => ({ ok: true, value: JSON.stringify('9007199254740993') }) })
  await run(`await call('open', { url: 'https://example.test/', surface: 'builtin' })`)
  const value = await run(`const id = await js('document.body.dataset.id')\n[typeof id, id]`)
  assert.equal(value.output, '["string","9007199254740993"]')
})

test('js() treats an expression with nested returns as an expression', async () => {
  const scripts = []
  const { run } = mount({ execute: async (_session, request) => { scripts.push(request.script); return { ok: true, value: '[2,4]' } } })
  await run(`await call('open', { url: 'https://example.test/', surface: 'builtin' })`)
  const value = await run('await js("[1,2].map(x => { return x * 2 })")')
  assert.equal(value.output, '[2,4]')
  assert.match(scripts.at(-1), /return \(\[1,2\]\.map/)
})

test('a call cancelled while its REPL starts runs no browser action', async () => {
  const { tools, calls } = mount()
  const controller = new AbortController()
  const pending = tools.get('dsh_browser_code').execute({ code: "await click('Buy')" }, { agent: { id: 'fresh-owner' }, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
  await new Promise(done => setTimeout(done, 300))
  assert.equal(calls.some(([name]) => name === 'click'), false)
})

test('the REPL that replaces a killed one keeps its variables', async () => {
  const { tools } = mount()
  const code = tools.get('dsh_browser_code')
  const exec = { agent: { id: 'replace-owner' } }
  await code.execute({ code: 'while (true) {}', timeoutMs: 1000 }, exec)
  await code.execute({ code: 'const fresh = 7' }, exec)
  await new Promise(done => setTimeout(done, 200))
  assert.equal((await code.execute({ code: 'fresh' }, exec)).output, '7')
})

test('cells become REPL cells: declarations persist and the last expression is the value', () => {
  assert.equal(prepare('const a = 1\nlet b = 2\na + b'), 'globalThis.a = 1\nglobalThis.b = 2\nreturn (a + b)')
  assert.equal(prepare('async function f() {\n  return 1\n}'), 'globalThis.f = async function f() {\n  return 1\n}')
  assert.equal(prepare('if (x) {\n  y()\n}'), 'if (x) {\n  y()\n}')
  assert.equal(prepare('return 5'), 'return 5')
})

test('string targets map to text, CSS or XPath locators', () => {
  assert.deepEqual(targetArgs('Sign in'), { target: { by: 'text', value: 'Sign in' } })
  assert.deepEqual(targetArgs('#email'), { target: { by: 'css', value: '#email' } })
  assert.deepEqual(targetArgs('input[name=q]'), { target: { by: 'css', value: 'input[name=q]' } })
  assert.deepEqual(targetArgs('button'), { target: { by: 'css', value: 'button' } })
  assert.deepEqual(targetArgs('Button text here'), { target: { by: 'text', value: 'Button text here' } })
  assert.deepEqual(targetArgs('select all'), { target: { by: 'text', value: 'select all' } })
  assert.deepEqual(targetArgs('ul > li'), { target: { by: 'css', value: 'ul > li' } })
  assert.deepEqual(targetArgs('//a[1]'), { target: { by: 'xpath', value: '//a[1]' } })
  assert.deepEqual(targetArgs({ css: '.item', index: 2 }), { target: { by: 'css', value: '.item', index: 2 } })
  assert.deepEqual(targetArgs({ x: 5, y: 6 }), { x: 5, y: 6 })
})
