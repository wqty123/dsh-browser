import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

test('different tasks concurrently claim different browser targets', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-concurrent-targets-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156', blanks: ['startup-blank'] })
  await browser.listen()
  writeFileSync(join(folder, 'DevToolsActivePort'), String(browser.port) + '\n')
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'never-spawned' }, folder)
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  try {
    await host.listPages()
    const a = await provider.open('task-A')
    const b = await provider.open('task-B')
    const c = await provider.open('task-C')
    await Promise.all([a, b, c].map(session => provider.execute(session, { script: '1' })))
    assert.equal(browser.attached.length, 3)
    assert.equal(new Set(browser.attached).size, 3, 'no page belongs to two tasks')
    assert.equal(browser.created.length, 2, 'the one startup page is adopted exactly once')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('an ephemeral profile is removed after its launched browser exits, not while it is still alive', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-ephemeral-exit-'))
  writeFileSync(join(folder, 'Cookies'), 'sample')
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, kill() { return true },
  })
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, folder, [], folder)
  // Inject only the process seam; no real browser or user profile is opened.
  host.child = child
  try {
    host.dispose()
    assert.equal(existsSync(folder), true, 'a live browser retains its profile during graceful shutdown')
    child.exitCode = 0
    child.emit('exit', 0, null)
    await new Promise(setImmediate)
    assert.equal(existsSync(folder), false, 'profile cleanup runs after the exit notification')
  } finally {
    child.exitCode = 0
    child.emit('exit', 0, null)
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a refused attach does not block the next task or permanently claim the blank page', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-refused-attach-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156', blanks: ['startup-blank'], failAttaches: 1 })
  await browser.listen()
  writeFileSync(join(folder, 'DevToolsActivePort'), String(browser.port) + '\n')
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'never-spawned' }, folder)
  try {
    await host.listPages()
    const results = await Promise.allSettled([
      host.createView().sendCommand('Runtime.evaluate', { expression: '1' }),
      host.createView().sendCommand('Runtime.evaluate', { expression: '2' }),
    ])
    assert.equal(results[0].status, 'rejected')
    assert.match(results[0].reason.message, /attach refused/)
    assert.equal(results[1].status, 'fulfilled')
    assert.deepEqual(browser.attached, ['startup-blank', 'startup-blank'])
    assert.deepEqual(browser.created, [])
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(folder, { recursive: true, force: true })
  }
})
