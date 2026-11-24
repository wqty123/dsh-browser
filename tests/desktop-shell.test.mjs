/**
 * Desktop shell classification (issue #62): a third-party shell is named, never patched, and the
 * system browser is recommended for it; only DeepSeek Harness Desktop is `official-supported`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { detectDesktopShell, findDesktopInstall } from '../lib/browser-electron/bridge-status.js'
import { classifyDesktopShell, systemCarrier } from '../lib/browser-electron/desktop-shell.js'
import { readDesktopIdentity } from '../lib/browser-electron/desktop-identity.js'
import { handleBridgeStatus } from '../lib/browser-electron/preview-route.js'
import { readRuntimeStatus } from '../lib/browser-electron/runtime-status.js'
import { writeAsar } from './fake-asar.mjs'

const none = () => []

function install(base, dir, { name, version, entries, packed = false }) {
  const root = join(base, 'Programs', dir)
  const manifest = JSON.stringify({ name, version })
  if (packed) {
    writeAsar(join(root, 'resources', 'app.asar'), { 'package.json': manifest, ...Object.fromEntries(entries.map(entry => [entry, 'console.log(1)\n'])) })
  } else {
    const app = join(root, 'resources', 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'package.json'), manifest)
    for (const entry of entries) {
      mkdirSync(join(app, ...entry.split('/').slice(0, -1)), { recursive: true })
      writeFileSync(join(app, ...entry.split('/')), 'console.log(1)\n')
    }
  }
  return root
}

const thirdParty = (base, packed) => install(base, 'DSH Desktop', { name: 'dsh-desktop', version: '0.14.0', entries: ['out/main/index.js'], packed })
const official = base => install(base, 'DeepSeek Harness', { name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.3', entries: ['lib/main.js'] })

function withBase(run) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
  try { return run(base) } finally { rmSync(base, { recursive: true, force: true }) }
}

for (const packed of [true, false]) {
  test(`a dataelement/dsh-desktop 0.14.0 shell (${packed ? 'packed' : 'unpacked'}) is a third-party shell, never patchable`, () => withBase(base => {
    const root = thirdParty(base, packed)
    const report = detectDesktopShell({ localAppData: base, registry: none, conventions: none, preferredBrowser: 'sidebar', platform: 'win32' })
    assert.equal(report.kind, 'third-party-shell')
    assert.equal(report.patchable, false)
    assert.equal(report.recommendedCarrier, 'edge')
    assert.equal(report.root, root)
    assert.equal(report.version, '0.14.0')
    assert.match(report.reason, /out\/main\/index\.js instead of lib\/main\.js/)
    assert.equal(findDesktopInstall(base, none, none), undefined, 'discovery never hands it to the installer')
  }))
}

test('the recommended system browser follows the user\'s channel, then the platform', () => {
  assert.equal(systemCarrier({ preferredBrowser: 'chrome', platform: 'win32' }), 'chrome')
  assert.equal(systemCarrier({ preferredBrowser: 'edge', platform: 'darwin' }), 'edge')
  assert.equal(systemCarrier({ preferredBrowser: 'auto', platform: 'darwin' }), 'chrome')
  assert.equal(systemCarrier({ platform: 'win32' }), 'edge')
})

test('DeepSeek Harness Desktop is official-supported and wins over a third-party shell beside it', () => withBase(base => {
  thirdParty(base, true)
  const root = official(base)
  const report = detectDesktopShell({ localAppData: base, registry: none, conventions: none })
  assert.deepEqual({ kind: report.kind, patchable: report.patchable, recommendedCarrier: report.recommendedCarrier, root: report.root },
    { kind: 'official-supported', patchable: true, recommendedCarrier: 'sidebar', root })
}))

test('an official package name without the patched entry is official-unsupported', () => withBase(base => {
  const root = install(base, 'DeepSeek Harness', { name: '@deepseek-ai/dsh-desktop', version: '0.3.0', entries: ['main.js'] })
  const report = classifyDesktopShell(root, readDesktopIdentity(root), { platform: 'linux' })
  assert.equal(report.kind, 'official-unsupported')
  assert.equal(report.patchable, false)
  assert.equal(report.recommendedCarrier, 'chrome')
}))

test('a foreign Electron app or an empty machine is none', () => withBase(base => {
  const root = install(base, 'Other', { name: 'other-app', version: '1.0.0', entries: ['lib/main.js'] })
  assert.equal(classifyDesktopShell(root, readDesktopIdentity(root)).kind, 'none')
  const report = detectDesktopShell({ localAppData: base, registry: none, conventions: none })
  assert.equal(report.kind, 'none')
  assert.equal(report.patchable, false)
  assert.match(report.reason, /no DSH Desktop install/)
}))

function request() {
  const stream = Readable.from([])
  return Object.assign(stream, { method: 'GET', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', referer: 'http://localhost:3000/' } })
}
function response() {
  const recorded = {}
  return { recorded, writeHead(status, headers) { recorded.status = status; recorded.headers = headers; return this }, setHeader() {}, end(body) { recorded.body = body } }
}

test('bridge status names a third-party shell and offers no repair command for it', async () => withBase(async base => {
  thirdParty(base, true)
  const res = response()
  await handleBridgeStatus(request(), res, base, undefined, none, none, 'chrome')
  const payload = JSON.parse(String(res.recorded.body))
  assert.equal(payload.shell.kind, 'third-party-shell')
  assert.equal(payload.shell.recommendedCarrier, 'chrome')
  assert.equal(payload.bridge.present, false)
  assert.equal(payload.bridge.command, undefined)
  assert.match(payload.bridge.detail, /out\/main\/index\.js/)
}))

test('runtime status carries the shell report for the settings page', () => {
  const shell = { kind: 'third-party-shell', patchable: false, reason: 'r', recommendedCarrier: 'edge' }
  const status = readRuntimeStatus({
    channel: () => 'sidebar', hasBinary: () => false, provision: () => ({ state: 'idle', detail: '' }),
    bridge: () => undefined, endpoint: () => undefined, detectBrowser: () => undefined, shell: () => shell,
  })
  assert.deepEqual(status.shell, shell)
  assert.equal(status.bridge.present, false)
})
