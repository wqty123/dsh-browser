import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { BrowserProcessOwnership, inspectProcess } from '../lib/browser-electron/process-ownership.js'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { sessionWireId, tabWireId } from '../lib/browser/handles.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-owned-process-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let killed = 0
  const child = Object.assign(new EventEmitter(), { pid: 900007, exitCode: null, signalCode: null,
    kill() { killed++; this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); return true } })
  const original = { pid: child.pid, created: 'birth-1', executable: process.execPath,
    argv: [process.execPath, `--user-data-dir=${directory}`] }
  let current = original
  const options = { managed: true, inspect: async () => current }
  const ownership = new BrowserProcessOwnership(process.execPath, directory, options)
  return { directory, child, original, options, ownership, get killed() { return killed }, set current(value) { current = value } }
}

test('verified child requires matching PID, birth, executable and exact profile before termination', async t => {
  const s = setup(t)
  await s.ownership.capture(s.child)
  assert.equal(await s.ownership.verify(s.child), true)
  assert.equal(await s.ownership.terminate(s.child), true)
  assert.equal(s.killed, 1)
  assert.equal(await s.ownership.terminate(s.child), false, 'an exited child cannot be killed again')
})

for (const [name, change] of [
  ['reused PID', value => ({ ...value, created: 'birth-2' })],
  ['wrong PID', value => ({ ...value, pid: value.pid + 1 })],
  ['different executable', value => ({ ...value, executable: '/not-the-browser' })],
  ['different profile', value => ({ ...value, argv: [process.execPath, '--user-data-dir=/personal'] })],
  ['similar profile prefix', value => ({ ...value, argv: [process.execPath, value.argv[1] + '-other'] })],
  ['duplicate profile switches', value => ({ ...value, argv: [...value.argv, value.argv[1]] })],
  ['unreadable process', () => undefined],
]) test(`cleanup fails closed: ${name}`, async t => {
  const s = setup(t)
  await s.ownership.capture(s.child)
  s.current = change(s.original)
  assert.equal(await s.ownership.terminate(s.child), false)
  assert.equal(s.killed, 0)
})

test('missing identity at spawn, personal mode and inspection errors grant no ownership', async t => {
  const s = setup(t)
  s.current = undefined
  await s.ownership.capture(s.child)
  s.current = s.original
  assert.equal(await s.ownership.terminate(s.child), false)
  const personal = new BrowserProcessOwnership(process.execPath, s.directory, { ...s.options, managed: false })
  await personal.capture(s.child)
  assert.equal(await personal.terminate(s.child), false)
  const denied = new BrowserProcessOwnership(process.execPath, s.directory, { managed: true, inspect: async () => { throw Error('denied') } })
  await denied.capture(s.child)
  assert.equal(await denied.terminate(s.child), false)
  assert.equal(s.killed, 0)
})

for (const argv of [[], [process.execPath], [process.execPath, '--user-data-dir'],
  [process.execPath, '--user-data-dir=', '--user-data-dir=']]) {
  test(`incomplete launch arguments grant no cleanup authority: ${JSON.stringify(argv)}`, async t => {
    const s = setup(t)
    s.current = { ...s.original, argv }
    await s.ownership.capture(s.child)
    assert.equal(await s.ownership.terminate(s.child), false)
    assert.equal(s.killed, 0)
  })
}

test('default personal profile is never a managed cleanup target', async t => {
  const s = setup(t), windows = process.platform === 'win32'
  if (process.platform === 'darwin') { t.skip('macOS identity inspection is fail-closed'); return }
  const variable = windows ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME', previous = process.env[variable]
  process.env[variable] = s.directory
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous })
  const personal = windows ? join(s.directory, 'Microsoft', 'Edge', 'User Data') : join(s.directory, 'microsoft-edge')
  mkdirSync(personal, { recursive: true })
  s.current = { ...s.original, argv: [process.execPath, `--user-data-dir=${personal}`] }
  const ownership = new BrowserProcessOwnership(process.execPath, personal, s.options)
  await ownership.capture(s.child)
  assert.equal(await ownership.terminate(s.child), false)
  assert.equal(s.killed, 0)
})

test('real OS inspection identifies and terminates only a separately spawned test child', {
  skip: !['linux', 'win32'].includes(process.platform) && 'unsupported inspection platform fails closed',
}, async t => {
  const s = setup(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/owned-process-child.mjs', import.meta.url)), `--user-data-dir=${s.directory}`], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  await once(child, 'spawn')
  const identity = await inspectProcess(child.pid)
  assert.equal(identity?.pid, child.pid)
  assert.ok(identity.created)
  const ownership = new BrowserProcessOwnership(process.execPath, s.directory, { managed: true })
  await ownership.capture(child)
  assert.equal(await ownership.verify(child), true)
  const exited = once(child, 'exit')
  assert.equal(await ownership.terminate(child), true)
  await exited
  assert.equal(await ownership.verify(child), false)
})

async function until(predicate) {
  const end = Date.now() + 3000
  while (!predicate()) { if (Date.now() > end) throw Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

async function carrier(t, { adopted = false, managed = true, endpointPid } = {}) {
  const s = setup(t)
  const browser = createFakeBrowser({ browserName: adopted ? 'Chrome/157' : 'Fake/1', browserPid: endpointPid ?? s.child.pid })
  await browser.listen()
  t.after(() => browser.kill())
  const portFile = join(s.directory, 'DevToolsActivePort')
  if (adopted) writeFileSync(portFile, `${browser.port}\n`)
  const host = new SystemBrowserViewHost({ kind: 'edge', path: process.execPath }, s.directory, [], undefined,
    () => { writeFileSync(portFile, `${browser.port}\n`); return s.child }, 'auto', () => false, undefined, { ...s.options, managed })
  t.after(() => { s.child.exitCode = 0; host.dispose() })
  const scope = sessionWireId({ owner: 'task-a', session: 'main' })
  const id = tabWireId({ owner: 'task-a', session: 'main', tab: 'view' })
  const view = host.createView(id)
  await view.sendCommand('Runtime.evaluate', { expression: '1' })
  return { s, browser, host, view, scope, id }
}

for (const mode of [{ adopted: true }, { managed: false }, { endpointPid: 900008 }]) {
  test(`borrowed, personal or mismatched endpoint is never closed: ${JSON.stringify(mode)}`, async t => {
    const { s, browser, host, view } = await carrier(t, mode)
    host.destroyView(view)
    await until(() => browser.commands.some(command => command.method === 'Target.detachFromTarget'))
    host.dispose()
    await until(() => !host.client)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(browser.commands.some(command => command.method === 'Browser.close'), false)
    assert.deepEqual(browser.closed, [])
    assert.equal(s.killed, 0)
  })
}

test('owned endpoint is gracefully closed only after fresh identity verification', async t => {
  const { browser, host } = await carrier(t)
  host.dispose()
  await until(() => browser.commands.some(command => command.method === 'Browser.close'))
  const methods = browser.commands.map(command => command.method)
  assert.ok(methods.lastIndexOf('SystemInfo.getProcessInfo') < methods.indexOf('Browser.close'))
})

test('changed ownership at teardown prevents browser-wide close and force cleanup', async t => {
  const { s, browser, host } = await carrier(t)
  s.current = { ...s.original, created: 'recycled' }
  host.dispose()
  assert.equal(await host.stopChild(s.child), false)
  assert.equal(s.killed, 0)
  assert.equal(browser.commands.some(command => command.method === 'Browser.close'), false)
  assert.equal(host.connectionStatus().launch.cleanup, 'ownership-unverified')
})

test('automatic teardown detaches; only explicit close can close an agent-created tab', async t => {
  const { s, browser, host, view, scope, id } = await carrier(t, { adopted: true })
  for (const method of ['Browser.close', 'Target.closeTarget', 'Page.close']) await assert.rejects(view.sendCommand(method), /explicit tab close/)
  host.destroyView(view)
  await until(() => browser.commands.some(command => command.method === 'Target.detachFromTarget'))
  assert.deepEqual(browser.closed, [])
  const same = host.createView(id)
  await same.sendCommand('Runtime.evaluate', { expression: '2' })
  const agentTarget = browser.created.at(-1)
  const otherScope = sessionWireId({ owner: 'task-b', session: 'main' })
  await assert.rejects(host.closePage(tabWireId({ owner: 'task-b', session: 'main', tab: `page:${agentTarget}` }), otherScope), /owner\/session/)
  assert.deepEqual(browser.closed, [])
  await host.closePage(id, scope)
  assert.deepEqual(browser.closed, [agentTarget])
  const personalId = tabWireId({ owner: 'task-a', session: 'main', tab: 'page:personal-existing' })
  const personal = await host.adoptPage(personalId, scope)
  await assert.rejects(host.closePage(personalId, scope), /detach-only/)
  host.destroyView(personal)
  await assert.rejects(host.closePage(tabWireId({ owner: 'other', session: 'elsewhere', tab: 'page:personal-existing' }), scope), /owner\/session/)
  host.dispose()
  assert.deepEqual(browser.closed, [agentTarget])
  assert.equal(s.killed, 0)
})

test('provider explicit close reaches the owned target and preserves the logical tab on refusal', async t => {
  const { browser, host } = await carrier(t, { adopted: true })
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  t.after(() => provider.dispose())
  const session = await provider.open('explicit-close-owner')
  await provider.execute(session, { script: '1' })
  const [tab] = await provider.listTabs(session)
  const target = browser.created.at(-1)
  const close = host.closePage.bind(host)
  host.closePage = async () => { throw Error('refused close') }
  await assert.rejects(provider.closeTab(session, tab.id), /refused close/)
  assert.equal((await provider.listTabs(session))[0].id, tab.id)
  assert.deepEqual(browser.closed, [])
  host.closePage = close
  await provider.closeTab(session, tab.id)
  assert.deepEqual(browser.closed, [target])
  await provider.close(session)
  assert.deepEqual(browser.closed, [target])
})

test('real managed-browser teardown leaves another running browser and its tabs alive', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable', timeout: 60000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-isolation-'))
  const browser = { kind: 'chrome', path: process.env.DSH_TEST_CHROME }
  const otherDir = join(root, 'personal'), managedDir = join(root, 'managed')
  mkdirSync(otherDir); mkdirSync(managedDir)
  const extra = process.platform === 'linux' ? ['--no-sandbox'] : []
  const other = new SystemBrowserViewHost(browser, otherDir, extra, undefined, undefined, 'always')
  const owned = new SystemBrowserViewHost(browser, managedDir, extra, undefined, undefined, 'always', () => false, undefined, { managed: true })
  let otherChild, ownedChild
  t.after(async () => {
    const children = new Set([otherChild, ownedChild, other.child, owned.child])
    other.dispose(); owned.dispose()
    for (const child of children) if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  })
  const personal = other.createView()
  await personal.sendCommand('Runtime.evaluate', { expression: 'globalThis.survives = 123' })
  otherChild = other.child
  await owned.createView().sendCommand('Runtime.evaluate', { expression: '1' })
  ownedChild = owned.child
  assert.notEqual(ownedChild.pid, otherChild.pid)
  const exited = once(ownedChild, 'exit')
  owned.dispose()
  await exited
  assert.equal(otherChild.exitCode, null)
  assert.equal(otherChild.signalCode, null)
  const result = await personal.sendCommand('Runtime.evaluate', { expression: 'globalThis.survives', returnByValue: true })
  assert.equal(result.result.value, 123)
})
