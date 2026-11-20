// dsh_browser_code is the model's whole browser surface: one script batches many actions, and
// every helper goes through the same registered tool (gates, sessions, rendering) as before.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'
import { targetArgs, prepare } from '../lib/tool-browser/code-worker.js'

function mount(overrides = {}, config = {}) {
  const tools = new Map()
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
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section: section => { sections.push(section) } },
    effect: fn => { disposers.push(fn()) },
    get: name => name === 'browser' ? browser : undefined,
  }, config)
  const exec = { agent: { id: 'code-owner' } }
  const run = code => tools.get('dsh_browser_code').execute({ code }, exec)
  return { tools, calls, sections, run }
}

test('the default surface is the code tool plus human takeover', () => {
  const { tools, sections } = mount()
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
