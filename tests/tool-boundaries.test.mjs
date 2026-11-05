import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, unlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { apply } from '../lib/tool-browser/index.js'
import { pageOperationScript } from '../lib/tool-browser/page-probe.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-tool-boundaries-'))
process.env.DSH_HOME = root
const workspace = join(root, 'task-workspace')
const outside = join(root, 'outside')
await mkdir(workspace)
await mkdir(outside)
await writeFile(join(workspace, 'allowed.txt'), 'task-file')
await writeFile(join(outside, 'secret.txt'), 'outside-file')

function mount(browser, extra = {}) {
  const tools = new Map()
  const ctx = {
    get: name => name === 'browser' ? browser : name === 'workingDirectory' ? extra.directory : undefined,
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} }, effect() {}, logger: console,
  }
  apply(ctx)
  const exec = { signal: new AbortController().signal, agent: { id: 'boundary-task', session: { header: { cwd: workspace } } } }
  return { run: (name, args) => tools.get('dsh_browser_' + name).execute(args, exec) }
}

test('upload uses the task workspace and rejects an external junction and oversized file before page execution', async t => {
  const seen = []
  const browser = {
    open: async () => 'browser:boundary', exists: () => true,
    pageOperation: async (_session, request) => {
      seen.push(request)
      return { ok: true, value: request.operation === 'upload' ? JSON.stringify({ ok: true, name: request.file.name, size: Buffer.from(request.file.base64, 'base64').length }) : 3 }
    },
  }
  const { run } = mount(browser)
  const target = { by: 'css', value: '#file' }
  const valid = await run('upload', { target, path: join(workspace, 'allowed.txt') })
  assert.equal(valid.ok, true)
  assert.equal(Buffer.from(seen.at(-1).file.base64, 'base64').toString(), 'task-file')
  const before = seen.length
  await assert.rejects(run('upload', { target, path: join(outside, 'secret.txt') }), /outside the task workspace/)
  assert.equal(seen.length, before)
  const large = join(workspace, 'large.bin')
  await writeFile(large, '')
  await truncate(large, 20 * 1024 * 1024 + 1)
  await assert.rejects(run('upload', { target, path: large }), /20 MB/)
  assert.equal(seen.length, before)
  const junction = join(workspace, 'linked-directory')
  try {
    await symlink(outside, junction, 'junction')
  } catch (error) {
    t.diagnostic('Junction creation is unavailable: ' + error.message)
    return
  }
  try {
    await assert.rejects(run('upload', { target, path: join(junction, 'secret.txt') }), /outside the task workspace/)
    assert.equal(seen.length, before)
  } finally {
    await unlink(junction)
  }
})

test('the working directory service takes precedence over the original session metadata', async () => {
  const browser = { open: async () => 'browser:cwd', exists: () => true, pageOperation: async () => ({ ok: true, value: 3 }) }
  const { run } = mount(browser, { directory: { ensure: async () => outside } })
  await assert.rejects(run('upload', { target: { by: 'css', value: '#file' }, path: join(workspace, 'allowed.txt') }), /outside the task workspace/)
})

function pageBrowser() {
  const page = vm.createContext({
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    location: { href: 'https://fixture.test/page' },
    document: { readyState: 'complete', title: 'Fixture', body: { innerText: 'Ready' }, documentElement: {}, querySelectorAll: () => [] },
    fetch: async () => ({ status: 200 }),
    alert() {}, confirm: () => true, prompt: () => '',
  })
  const browser = {
    open: async () => 'browser:page', exists: () => true,
    pageOperation: async (_session, request) => ({ ok: true, value: vm.runInContext(pageOperationScript(request), page) }),
  }
  return { page, browser }
}

test('response waits reject previous completions and accept a request completed while waiting', async () => {
  const { page, browser } = pageBrowser()
  const { run } = mount(browser)
  await browser.pageOperation('', { operation: 'install' })
  await vm.runInContext('fetch("/completed")', page)
  assert.equal((await run('wait_for_response', { urlContains: '/completed', timeoutMs: 0 })).matched, false)
  let complete
  const original = page.fetch
  page.fetch = () => new Promise(resolve => { complete = resolve })
  // Install a fresh probe around the deferred transport.
  vm.runInContext('__dshProbe.dispose()', page)
  await browser.pageOperation('', { operation: 'install' })
  const pending = vm.runInContext('fetch("/pending")', page)
  const waiting = run('wait_for_response', { urlContains: '/pending', timeoutMs: 1000 })
  setTimeout(() => complete({ status: 201 }), 20)
  assert.equal((await waiting).entry.status, 201)
  await pending
  page.fetch = original
})

test('batch accepts the documented object forms and the existing shorthand', async () => {
  const calls = []
  const browser = {
    open: async () => 'browser:batch', exists: () => true,
    openUrl: async (_s, request) => calls.push(['open', request.url]),
    click: async (_s, request) => calls.push(['tap', request.target.value]),
    setValue: async (_s, request) => calls.push(['field', request.value]),
    type: async (_s, request) => calls.push(['type', request.text]),
    key: async (_s, request) => calls.push(['key', request.key]),
    scroll: async (_s, request) => calls.push(['scroll', request.deltaY]),
    execute: async () => ({ ok: true, value: 'script result' }),
    pageOperation: async (_s, request) => ({ ok: true, value: request.operation === 'text' ? 'true' : request.operation === 'url' ? '"https://fixture.test/page"' : request.operation === 'probe' ? '{"pending":0,"quietMs":500}' : 3 }),
  }
  const { run } = mount(browser)
  const value = await run('do', { autoDismiss: false, steps: [
    { open: { url: 'https://fixture.test/page' } },
    { tap: { target: { by: 'css', value: '#go' } } },
    { field: { target: { by: 'css', value: '#name' }, text: 'typed' } },
    { type: { text: 'more' } }, { key: { key: 'Enter' } }, { scroll: { deltaY: 10 } },
    { sleep_ms: { ms: 0 } }, { wait_text: { text: 'Ready' } },
    { wait_url: { url: '/page' } }, { wait_idle: {} }, { eval: { script: 'return 1' } },
    { tap: { by: 'css', value: '#direct' } },
  ] })
  assert.equal(value.ok, true, value.reason)
  assert.equal(value.completed, 12)
  assert.deepEqual(calls[1], ['tap', '#go'])
  assert.deepEqual(calls.at(-1), ['tap', '#direct'])
})