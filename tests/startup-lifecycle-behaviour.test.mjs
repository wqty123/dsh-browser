// The two startup behaviours from #29, exercised against a browser that can be observed.
//
// The guards in startup-lifecycle.test.mjs assert the SHAPE of the code (adoption before launch,
// discovery before listing). They cannot tell whether adoption actually attaches a view to the
// page the browser already opened, or whether a surplus page is really closed. Both of those are
// the whole point of the fix, and both are invisible in the tool layer — a discarded page never
// appears in `list_tabs`, so nothing downstream would notice it was lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/** A child-process stub the launcher returns; the host only reads exit codes off it. */
function fakeChild() {
  return { exitCode: null, signalCode: null, kill() {}, once() {}, on() {} }
}

/**
 * A host pointed at one fake browser, with the launch path wired to it.
 * @returns the host, plus what the launcher saw.
 */
async function hostFor(browser, { spawn = false } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const launches = []
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    profileDir,
    [],
    undefined,
    () => {
      launches.push(Date.now())
      // The browser a launch would produce is this fake, which is already listening.
      writeFileSync(join(profileDir, 'DevToolsActivePort'), `${browser.port}\n`)
      return fakeChild()
    },
  )
  if (spawn) {
    // Only needed for the adoption test: it is the port file that points at the running browser.
    writeFileSync(join(profileDir, 'DevToolsActivePort'), `${browser.port}\n`)
  }
  return { host, profileDir, launches }
}

test('a view adopts the page the browser opened, and the surplus is closed', async () => {
  // Two blanks, which is what a real Chrome has by the time a client can talk to it.
  const browser = createFakeBrowser({ blanks: ['blank-kept', 'blank-surplus'] })
  await browser.listen()
  const { host, profileDir } = await hostFor(browser)
  const view = host.createView()
  try {
    const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' })
      .then(() => 'ok', error => String(error.message))
    assert.equal(outcome, 'ok', `the command must reach the browser (${outcome})`)

    // Discovery came first. Listing before turning it on can omit pages that existed before the
    // handshake — precisely the page this fix is about — which is how the first attempt at it
    // failed without saying anything.
    assert.equal(browser.listedBeforeDiscovery, 0, 'discovery was enabled before any listing')

    // The view is on a page the browser ALREADY had, not on one the client made.
    assert.deepEqual(browser.attached, ['blank-kept'], 'the view adopted the page that was already there')
    assert.deepEqual(browser.created, [], 'and nothing was created, so nothing was discarded')

    // Exactly the surplus went away — one blank is kept for the view to adopt.
    assert.deepEqual(browser.closed, ['blank-surplus'], 'the surplus blank was closed')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('with a single blank, nothing is closed and that one is adopted', async () => {
  // The steady state a fix has to preserve: no surplus means no closing, and the page is still
  // reused rather than duplicated.
  const browser = createFakeBrowser({ blanks: ['only-blank'] })
  await browser.listen()
  const { host, profileDir } = await hostFor(browser)
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    assert.deepEqual(browser.attached, ['only-blank'], 'the single blank is adopted')
    assert.deepEqual(browser.closed, [], 'and nothing is closed')
    assert.deepEqual(browser.created, [], 'and nothing is created')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a browser left running by a previous DSH is adopted, and none is launched', async () => {
  const browser = createFakeBrowser({ browserName: 'Chrome/154.0.0.0' })
  await browser.listen()
  const { host, profileDir, launches } = await hostFor(browser, { spawn: true })
  const view = host.createView()
  try {
    const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' })
      .then(() => 'ok', error => String(error.message))
    assert.equal(outcome, 'ok', `the command must reach the adopted browser (${outcome})`)
    assert.equal(launches.length, 0,
      'nothing was launched — this is the whole fix: the running browser is used, not raced')
    assert.ok(browser.connections >= 1, 'and the running browser is the one that answered')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('an endpoint that is not a browser is refused, and a launch happens instead', async () => {
  // The safety half of adoption. A blank-looking port file with something behind it that does not
  // identify as a browser must not be adopted: the launch loop's original refusal to trust a
  // stale port exists for this, and adoption must not quietly undo it.
  const browser = createFakeBrowser({ browserName: 'not-a-browser/1.0' })
  await browser.listen()
  const { host, profileDir, launches } = await hostFor(browser, { spawn: true })
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' }).catch(() => {})
    assert.ok(launches.length >= 1, 'the endpoint was refused and a launch was attempted')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
