import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

beforeEach(t => {
  const port = process.env.DSH_BROWSER_ATTACH_PORT
  delete process.env.DSH_BROWSER_ATTACH_PORT
  t.after(() => {
    if (port === undefined) delete process.env.DSH_BROWSER_ATTACH_PORT
    else process.env.DSH_BROWSER_ATTACH_PORT = port
  })
})

test('a launcher exiting zero still gets the same launch deadline and a single target decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-transaction-'))
  const browser = createFakeBrowser()
  await browser.listen()
  let launches = 0
  const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() {} })
  let portTimer
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, dir, [], undefined, () => {
    launches++
    portTimer = setTimeout(() => writeFileSync(join(dir, 'DevToolsActivePort'), `${browser.port}\n`), 1600)
    return child
  })
  try {
    const view = host.createView()
    await Promise.all([1, 2, 3].map(() => view.sendCommand('Runtime.evaluate', { expression: '1' })))
    assert.equal(launches, 1)
    assert.equal(browser.created.length, 1)
    assert.equal(browser.attached.length, 1)
    assert.deepEqual(browser.closed, [])
  } finally {
    clearTimeout(portTimer)
    host.dispose()
    await browser.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('competing hosts cannot launch or attach to the same leased profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-transaction-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156' })
  await browser.listen()
  writeFileSync(join(dir, 'DevToolsActivePort'), `${browser.port}\n`)
  const first = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, dir)
  const second = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, dir)
  try {
    await first.createView().sendCommand('Runtime.evaluate', { expression: '1' })
    await assert.rejects(second.createView().sendCommand('Runtime.evaluate', { expression: '1' }), /profile is leased/)
    assert.equal(browser.connections, 1)
    assert.equal(browser.created.length, 1)
  } finally {
    second.dispose()
    first.dispose()
    await browser.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const mode of ['identity', 'inventory']) {
  test(`a missing ${mode} acknowledgement cannot create a page or publish a usable view`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-refusal-'))
    const browser = createFakeBrowser({ browserName: 'Chrome/156', ...(mode === 'identity' ? { product: '' } : { invalidInventory: true }) })
    await browser.listen()
    writeFileSync(join(dir, 'DevToolsActivePort'), `${browser.port}\n`)
    let launches = 0
    const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, dir, [], undefined, () => { launches++; throw new Error('unexpected launch') })
    try {
      await assert.rejects(host.createView().sendCommand('Runtime.evaluate', { expression: '1' }), /did not acknowledge/)
      assert.equal(launches, 0)
      assert.deepEqual(browser.created, [])
      assert.deepEqual(browser.attached, [])
    } finally {
      host.dispose()
      await browser.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a slow discovery response gets the adoption deadline, not the launch polling interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-slow-adoption-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156', versionDelayMs: 350 })
  await browser.listen()
  writeFileSync(join(dir, 'DevToolsActivePort'), `${browser.port}\n`)
  let launches = 0
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, dir, [], undefined, () => { launches++; throw new Error('unexpected launch') })
  try {
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
    assert.equal(launches, 0)
    assert.equal(browser.created.length, 1)
    assert.equal(browser.attached.length, 1)
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an expired adoption probe cannot authorize launching another browser', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launch-adoption-timeout-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), '12345\n')
  const timeout = new DOMException('discovery deadline expired', 'TimeoutError')
  t.mock.method(globalThis, 'fetch', async () => { throw timeout })
  let launches = 0
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, dir, [], undefined, () => { launches++; throw new Error('unexpected launch') })
  try {
    await assert.rejects(host.createView().sendCommand('Runtime.evaluate', { expression: '1' }), error => {
      assert.match(error.message, /did not acknowledge its discovery endpoint/)
      assert.equal(error.cause, timeout)
      return true
    })
    assert.equal(launches, 0)
  } finally {
    host.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
