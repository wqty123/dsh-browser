// Choosing which browser carries the agent's pages.
//
// Detection is a pure function of the environment so it can be tested without a
// particular machine: an explicit choice must never silently become a different
// browser, and an unavailable choice must be reported rather than guessed at.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectBrowser, SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'

/** An env where every candidate path exists. */
const everything = {
  DSH_BROWSER_CHROME_PATH: process.execPath,
  DSH_BROWSER_EDGE_PATH: process.execPath,
}

/**
 * A directory holding empty files with the given names, usable as a fake PATH entry.
 *
 * Detection only asks whether a path exists, so the contents do not matter — this
 * makes the platform-specific lookup testable without those browsers being installed.
 */
function fakeBin(names) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-bin-'))
  for (const name of names) writeFileSync(join(dir, name), '')
  return dir
}

test('the bundled choice never resolves to a system browser', () => {
  assert.equal(detectBrowser('bundled', everything), undefined)
})

test('an explicit choice resolves to that browser', () => {
  assert.equal(detectBrowser('chrome', everything)?.kind, 'chrome')
  assert.equal(detectBrowser('edge', everything)?.kind, 'edge')
  assert.equal(detectBrowser('auto', everything)?.kind, 'chrome', 'auto prefers Chrome')
})

test('an injected path wins over the hardcoded locations', () => {
  // The environment override exists for non-default installs; when it points at a
  // real file it must be used, which is also how this test avoids depending on
  // whether Chrome happens to be installed on the machine running it.
  assert.equal(detectBrowser('chrome', { DSH_BROWSER_CHROME_PATH: process.execPath })?.path, process.execPath)
})

test('a path that does not exist is never returned', () => {
  // Whatever is resolved must be a real executable: a stale override pointing at an
  // uninstalled browser must not be handed to spawn.
  const found = detectBrowser('auto', {
    DSH_BROWSER_CHROME_PATH: 'D:\\definitely\\missing\\chrome.exe',
    DSH_BROWSER_EDGE_PATH: 'D:\\definitely\\missing\\msedge.exe',
  })
  if (found !== undefined) {
    assert.notEqual(found.path, 'D:\\definitely\\missing\\chrome.exe')
    assert.notEqual(found.path, 'D:\\definitely\\missing\\msedge.exe')
  }
})

test('the resolved path is the one that exists', () => {
  const found = detectBrowser('chrome', everything)
  assert.equal(found?.path, process.execPath)
})

// Reported bug: merely loading the plugin launched Chrome, because the host started
// the browser in its constructor. Registration has to be inert — a browser may only
// appear once something actually asks for a page.
test('constructing the host starts nothing', () => {
  // A path that cannot launch: if construction tried, this would spawn (and fail).
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: join(tmpdir(), 'definitely-not-a-browser.exe') },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  assert.equal(host.started, false, 'no process at construction')
  assert.equal(host.available(), true, 'and the host is still usable')
  // Disposing an unused host must be a clean no-op (nothing to kill, nothing to throw).
  assert.doesNotThrow(() => host.dispose())
})

test('an unused host never spawns anything', () => {
  // Same contract from the other side: registering and releasing must leave no
  // process behind. `started` is the observable proof.
  const host = new SystemBrowserViewHost(
    { kind: 'edge', path: join(tmpdir(), 'also-not-a-browser.exe') },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  host.dispose()
  assert.equal(host.started, false)
})

// A released host must stay released: using it afterwards would spawn a browser
// nobody owns and nobody will kill. (`available()` correctly reports false here,
// which is also what stops the plugin from routing work to a dead carrier.)
test('a released host refuses to start a browser', async () => {
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: join(tmpdir(), 'never-a-browser.exe') },
    mkdtempSync(join(tmpdir(), 'dsh-browser-profile-')),
  )
  host.dispose()
  assert.equal(host.available(), false, 'a disposed host reports itself unusable')
  const view = host.createView()
  await assert.rejects(
    () => view.sendCommand('Runtime.evaluate', { expression: '1' }),
    /released/,
    'the command fails instead of launching anything',
  )
  assert.equal(host.started, false, 'and no process was spawned')
})

// Issue #19: on Linux the browser is normally a launcher on PATH, packaged under a
// versioned name — microsoft-edge-stable, google-chrome-stable — and the Windows
// Application layout this file originally assumed does not exist there at all.
//
// A caveat about these tests: a Linux PATH cannot be simulated faithfully on Windows,
// because every absolute Windows path already contains a colon (C:\...) that a
// colon-separated split would tear apart. So what is asserted here is what this
// platform can actually verify — the Windows separator, the lookup order, the
// per-platform isolation — plus the Linux table's contents, read from the source.
test('the Linux launcher names are the packaged ones', () => {
  const source = readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')
  assert.match(source, /linux: \['microsoft-edge-stable'/, 'the versioned Edge launcher is listed')
  assert.match(source, /linux: \['google-chrome-stable'/, 'the versioned Chrome launcher is listed')
  assert.match(source, /'\/usr\/bin\/microsoft-edge-stable'/, 'and a fixed Linux location too')
  assert.match(source, /darwin: \[/, 'as are macOS bundle paths')
})

test('a Windows PATH is split on the Windows separator', () => {
  const empty = fakeBin([])
  const bin = fakeBin(['chrome.exe'])
  // The browser is only in the second directory, so splitting on the wrong separator
  // would mangle the whole string into one path and miss it.
  assert.equal(detectBrowser('chrome', { PATH: empty + ';' + bin }, 'win32')?.path, join(bin, 'chrome.exe'))
})

test('a single PATH directory is searched as-is', () => {
  const bin = fakeBin(['msedge.exe'])
  assert.equal(detectBrowser('edge', { PATH: bin }, 'win32')?.path, join(bin, 'msedge.exe'))
})

test('the Windows lookup also accepts the Path spelling', () => {
  // Windows spells it both ways depending on who set it.
  const bin = fakeBin(['chrome.exe'])
  assert.equal(detectBrowser('chrome', { Path: bin }, 'win32')?.path, join(bin, 'chrome.exe'))
})

test('a directory without a matching launcher is not a hit', () => {
  const bin = fakeBin(['something-else.exe'])
  assert.notEqual(detectBrowser('brave', { PATH: bin }, 'win32')?.path, join(bin, 'something-else.exe'))
})

test('an explicit override still outranks PATH', () => {
  const bin = fakeBin(['chrome.exe'])
  const found = detectBrowser('chrome', { PATH: bin, DSH_BROWSER_CHROME_PATH: process.execPath }, 'win32')
  assert.equal(found?.path, process.execPath)
})
