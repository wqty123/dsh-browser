import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-panel-session-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))
const { apply } = await import('../lib/tool-browser/index.js')
const { getLastOpen } = await import('../lib/browser-electron/open-slot.js')

function mount(overrides = {}, owner = 'panel-task') {
  const calls = []
  let url = 'https://example.com/'
  let title = 'Visible page'
  const record = (name, result) => async (session, request) => {
    calls.push({ name, session, request })
    return typeof result === 'function' ? result(request) : result
  }
  const browser = {
    open: record('open', 'browser:builtin'),
    openPanel: record('openPanel', 'browser:panel'),
    exists: () => true,
    close: record('close'),
    openUrl: record('openUrl', request => { url = request.url }),
    snapshot: record('snapshot', () => ({ url, title, elements: [], truncated: false })),
    a11y: record('a11y', () => ({ url, title, count: 0, nodes: [], truncated: false })),
    content: record('content', { content: 'live content', truncated: false }),
    scrape: record('scrape', { count: 0, items: [] }),
    screenshot: record('screenshot', { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }),
    click: record('click'),
    type: record('type'),
    download: record('download', { path: join(home, 'download.txt') }),
    pageOperation: record('pageOperation', request => ({ ok: true, value: request.operation === 'upload'
      ? JSON.stringify({ ok: true, name: request.file.name, size: Buffer.from(request.file.base64, 'base64').length }) : 3 })),
    execute: record('execute', () => ({ ok: true, value: { ok: true, url, title,
      events: [{ kind: 'text', exact: 'Selected words', prefix: 'Before ', suffix: ' after' }] } })),
    ...overrides,
  }
  const tools = new Map()
  const cleanups = []
  const exec = { signal: new AbortController().signal, agent: { id: owner,
    session: { header: { cwd: home } }, ctx: { effect: effect => { cleanups.push(effect()) } } } }
  apply({ tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} }, effect() {}, get: name => name === 'browser' ? browser : undefined })
  return { browser, calls, exec, cleanups,
    navigate: (next, heading) => { url = next; title = heading },
    run: (name, args = {}) => tools.get('dsh_browser_' + name).execute(args, exec) }
}

const operations = [
  ['snapshot', {}], ['a11y', {}], ['content', { format: 'txt' }],
  ['scrape', { item: '.item', fields: { title: 'h2' } }], ['screenshot', {}],
  ['click', { target: { by: 'css', value: '#go' } }], ['type', { text: 'hello' }],
  ['upload', { target: { by: 'css', value: '#file' }, path: join(home, 'upload.txt') }],
  ['download', { url: 'https://example.com/file', savePath: join(home, 'download.txt') }],
  ['reference_capture', {}],
]
writeFileSync(join(home, 'upload.txt'), 'upload bytes')

test('default panel open drives every operation on its live sidebar session, without a builtin open', async () => {
  const { run, calls, navigate } = mount()
  const opened = await run('open', { url: 'https://example.com/' })
  assert.equal(opened.title, 'Visible page')
  assert.deepEqual(opened.elements, [])
  navigate('https://example.com/human-navigation', 'Changed by human')
  assert.equal((await run('snapshot')).title, 'Changed by human')
  assert.equal((await run('a11y')).url, 'https://example.com/human-navigation')
  for (const [name, args] of operations) {
    const start = calls.length
    const value = await run(name, args)
    if (name === 'reference_capture') assert.equal(value.ok, true)
    if (name === 'upload') assert.equal(value.ok, true)
    assert.ok(calls.length > start, name + ' reached the live session')
    assert.ok(calls.slice(start).every(call => call.session === 'browser:panel'), name + ' stayed on the sidebar')
  }
  assert.equal(calls.filter(call => call.name === 'open').length, 0)
  assert.equal(calls.filter(call => call.name === 'openPanel').length, 1)
  const references = await run('reference_list')
  assert.equal(references.references[0].carrier, 'sidebar')
})

test('a Web panel queues explicit iframe navigation without claiming a live task session or fallback browser', async () => {
  const { run, calls } = mount({ openPanel: async () => undefined })
  const opened = await run('open', { url: 'https://example.com/' })
  assert.equal(opened.carrier, 'panel-iframe-navigation-requested')
  assert.equal(getLastOpen().owner, 'panel-task', 'a different foreground conversation must not consume this tool open')
  assert.deepEqual(opened.elements, [])
  for (const [name, args] of [...operations, ['state', {}]]) {
    await assert.rejects(run(name, args), error => {
      assert.match(error.message, /panel surface/)
      assert.match(error.message, /CDP-backed DSH desktop sidebar/)
      assert.doesNotMatch(error.message, /nothing is open/)
      return true
    })
  }
  assert.deepEqual(calls, [], 'neither a static refetch nor another browser was used')
  await run('reset_session')
  await assert.rejects(run('a11y'), /nothing is open/)
})

test('reading an unopened task never opens any surface', async () => {
  const { run, calls } = mount()
  for (const [name, args] of operations) await assert.rejects(run(name, args), /nothing is open/)
  assert.deepEqual(calls, [])
})

test('a queued iframe open can be retried after a CDP provider connects', async () => {
  const { run, browser, calls } = mount({ openPanel: undefined })
  assert.equal((await run('open', { url: 'https://example.com/' })).carrier, 'panel-iframe-navigation-requested')
  assert.deepEqual(calls, [])
  browser.openPanel = async () => 'browser:panel'
  assert.equal((await run('open', { url: 'https://example.com/' })).title, 'Visible page')
  await run('screenshot')
  assert.equal(calls.at(-1).session, 'browser:panel')
  assert.equal(calls.some(call => call.name === 'open'), false)
})

test('builtin -> CDP panel -> builtin switches sessions instead of driving a stale page', async () => {
  const { run, calls } = mount()
  await run('open', { url: 'https://old.example/', surface: 'builtin' })
  await run('open', { url: 'https://new.example/' })
  await run('content', { format: 'txt' })
  assert.equal(calls.at(-1).session, 'browser:panel')
  assert.ok(calls.some(call => call.name === 'close' && call.session === 'browser:builtin'))
  await run('open', { url: 'https://third.example/', surface: 'builtin' })
  await run('a11y')
  assert.equal(calls.at(-1).session, 'browser:builtin')
  assert.ok(calls.some(call => call.name === 'close' && call.session === 'browser:panel'))
})

test('a queued Web panel switch closes the old session instead of driving its stale page', async () => {
  const { run, calls } = mount({ openPanel: async () => undefined })
  await run('open', { url: 'https://old.example/', surface: 'builtin' })
  assert.equal((await run('open', { url: 'https://new.example/' })).carrier, 'panel-iframe-navigation-requested')
  assert.equal(getLastOpen().url, 'https://new.example/')
  const before = calls.length
  await assert.rejects(run('content', { format: 'txt' }), /panel surface has no live CDP session/)
  assert.equal(calls.length, before)
  assert.ok(calls.some(call => call.name === 'close' && call.session === 'browser:builtin'))
})

test('panel navigation errors propagate, close the failed session, and never fall back to builtin', async () => {
  const failure = new Error('sidebar navigation failed')
  const { run, calls } = mount({ openUrl: async () => { throw failure } })
  await assert.rejects(run('open', { url: 'https://example.com/' }), error => error === failure)
  assert.deepEqual(calls.map(call => call.name), ['openPanel', 'close'])
  await assert.rejects(run('a11y'), /nothing is open/)
})

test('a failed panel switch does not replace the working builtin session', async () => {
  const { run, browser, calls } = mount()
  await run('open', { url: 'https://old.example/', surface: 'builtin' })
  browser.openUrl = async () => { throw new Error('network failed') }
  await assert.rejects(run('open', { url: 'https://new.example/' }), /network failed/)
  await run('a11y')
  assert.equal(calls.at(-1).session, 'browser:builtin')
})

test('a stale panel session yields a capability error without launching a replacement', async () => {
  const { run, browser, calls } = mount()
  await run('open', { url: 'https://example.com/' })
  browser.exists = () => false
  const before = calls.length
  await assert.rejects(run('screenshot'), /panel surface/)
  assert.equal(calls.length, before)
})

test('panel sessions close with their task and the next read requires an explicit open', async () => {
  const { run, calls, cleanups } = mount()
  await run('open', { url: 'https://example.com/' })
  for (const cleanup of cleanups) cleanup()
  assert.ok(calls.some(call => call.name === 'close' && call.session === 'browser:panel'))
  await assert.rejects(run('a11y'), /nothing is open/)
})

test('reads wait for an in-flight explicit panel open but never initiate one', async () => {
  let ready
  let started
  const opening = new Promise(resolve => { ready = resolve })
  const reached = new Promise(resolve => { started = resolve })
  const { run, calls } = mount({ openPanel: async () => { started(); return opening } })
  const pending = run('open', { url: 'https://example.com/' })
  await reached
  const reading = run('a11y')
  ready('browser:panel')
  await pending
  await reading
  assert.equal(calls.at(-1).name, 'a11y')
  assert.equal(calls.at(-1).session, 'browser:panel')
})

test('loopback targets are supported on the native CDP panel, not on the Web proxy panel', async () => {
  const native = mount()
  await native.run('open', { url: 'http://127.0.0.1:4444/page' })
  assert.ok(native.calls.some(call => call.name === 'openUrl'))
  const web = mount({ openPanel: async () => undefined })
  await assert.rejects(web.run('open', { url: 'http://127.0.0.1:4444/page' }), /cannot host this machine/)
  assert.deepEqual(web.calls, [])
})

test('reopening the panel reuses the live session and registers task cleanup only once', async () => {
  const { run, calls, cleanups } = mount()
  await run('open', { url: 'https://example.com/first' })
  await run('open', { url: 'https://example.com/second', newTab: true })
  assert.equal(calls.filter(call => call.name === 'openPanel').length, 1)
  assert.deepEqual(calls.filter(call => call.name === 'openUrl').at(-1).request,
    { url: 'https://example.com/second', newTab: true })
  assert.equal(cleanups.length, 1)
  cleanups[0]()
  await assert.rejects(run('snapshot'), /nothing is open/)
})

test('panel snapshot and discovery failures are not disguised as successful empty opens', async () => {
  const snapshot = mount({ snapshot: async () => { throw new Error('CDP disconnected') } })
  await assert.rejects(snapshot.run('open', { url: 'https://example.com/' }), /CDP disconnected/)
  assert.ok(snapshot.calls.some(call => call.name === 'close' && call.session === 'browser:panel'))
  const discovery = mount({ openPanel: async () => { throw new Error('bridge refused') } })
  await assert.rejects(discovery.run('open', { url: 'https://example.com/' }), /bridge refused/)
  assert.deepEqual(discovery.calls, [])
})

test('a cancelled panel open never launches a browser or establishes a task session', async () => {
  const { run, calls, exec } = mount()
  const controller = new AbortController()
  controller.abort(new Error('cancelled before open'))
  exec.signal = controller.signal
  await assert.rejects(run('open', { url: 'https://example.com/' }), /cancelled before open/)
  assert.deepEqual(calls, [])
  await assert.rejects(run('a11y'), /nothing is open/)
})

test('concurrent explicit panel opens serialize navigation and share one live session', async () => {
  const { run, calls } = mount()
  await Promise.all([
    run('open', { url: 'https://example.com/first' }),
    run('open', { url: 'https://example.com/second' }),
  ])
  assert.equal(calls.filter(call => call.name === 'openPanel').length, 1)
  assert.deepEqual(calls.filter(call => call.name === 'openUrl').map(call => call.request.url),
    ['https://example.com/first', 'https://example.com/second'])
})
