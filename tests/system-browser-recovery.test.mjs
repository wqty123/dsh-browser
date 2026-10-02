// Issue #21: a browser that dies mid-session must not poison every later call.
//
// The report: with chrome/edge as the carrier, closing the browser window left every
// browser_* call hanging for 30s with no new process ever started, recoverable only by
// restarting DSH. The cause was that nothing watched the process after startup, so
// ensureClient() kept returning a connection to a dead browser.
//
// These use a stub executable that exits at once, which is the closest a test can get to
// "the browser died" without a real browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'

/** A directory holding a stub "browser" that exits immediately. */
function stubBrowser() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stub-browser-'))
  const path = join(dir, process.platform === 'win32' ? 'stub-browser.cmd' : 'stub-browser')
  if (process.platform === 'win32') {
    // A .cmd that returns straight away: spawn succeeds, the process is gone immediately.
    writeFileSync(path, '@echo off\r\nexit /b 0\r\n')
  } else {
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
  }
  return path
}

test('a browser that exits is not reported as a usable connection', async () => {
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: stubBrowser() },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  const view = host.createView()

  // The command must FAIL, and reasonably promptly. Before the fix it hung for the whole
  // CDP budget and then reported a timeout that said nothing about the browser being gone.
  const started = Date.now()
  await assert.rejects(
    () => view.sendCommand('Runtime.evaluate', { expression: '1' }),
    error => {
      // Whatever the wording, it must not be the generic CDP timeout.
      assert.doesNotMatch(error.message, /did not expose CDP within 30s/, `misleading error: ${error.message}`)
      return true
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 20_000, `failed in ${elapsed}ms; a dead browser should not consume the whole budget`)
  host.dispose()
})

test('a dead browser is not cached as a live client', async () => {
  // The cache is the bug: ensureClient() returned the connection unconditionally, so the
  // failure never cleared and every later call repeated it. Two calls in a row must both
  // fail quickly rather than the second one hanging on a stale client.
  const host = new SystemBrowserViewHost(
    { kind: 'edge', path: stubBrowser() },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  const view = host.createView()
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }))

  const started = Date.now()
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '2' }))
  assert.ok(Date.now() - started < 20_000, 'the second call did not hang on a stale client')
  host.dispose()
})
