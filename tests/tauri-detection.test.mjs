/**
 * DSH Tauri used to be reported as "DSH Desktop not found": it has no resources/app(.asar). It is
 * recognised by its electron-rs.json identifier, from the running executable or the install roots,
 * and is never handed to the Desktop bridge installer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDesktopShell, findDesktopInstall } from '../lib/browser-electron/bridge-status.js'
import { findTauriRuntime, runningTauriRuntime } from '../lib/browser-electron/tauri-host.js'
import { readRuntimeStatus } from '../lib/browser-electron/runtime-status.js'
import { registeredInstallLocations } from '../desktop-bridge/desktop-discovery.mjs'

const none = () => []
const fixture = name => new URL(`./fixtures/dsh-host-patch/tauri-0.33.0/${name}`, import.meta.url)

function withBase(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-tauri-shell-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return base
}

function tauri(base, { identifier = 'dsh-tauri', target = process.platform, arch = process.arch } = {}) {
  const root = join(base, 'DSH Tauri')
  const runtime = join(root, 'runtime', `${target}-${arch}`)
  mkdirSync(join(runtime, 'runtime'), { recursive: true })
  writeFileSync(join(runtime, 'electron-rs.json'), JSON.stringify({ appName: 'DSH Tauri', binary: 'DSH Tauri.exe', identifier, target, arch, version: 2 }))
  copyFileSync(fixture('browser.cjs'), join(runtime, 'runtime', 'browser.cjs'))
  return { root, runtime, executable: join(runtime, 'DSH Tauri.exe') }
}

function official(base) {
  const app = join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app')
  mkdirSync(join(app, 'lib'), { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.3' }))
  writeFileSync(join(app, 'lib', 'main.js'), 'console.log(1)\n')
}

test('an installed DSH Tauri is a tauri shell with an applicable sidebar host patch, never a bridge target', t => {
  const base = withBase(t)
  const { root, runtime } = tauri(base)
  const report = detectDesktopShell({ localAppData: base, registry: none, conventions: none, execPath: '/usr/bin/node' })
  assert.deepEqual({ kind: report.kind, patchable: report.patchable, root: report.root, runtime: report.runtime, running: report.running, status: report.hostPatch?.status },
    { kind: 'tauri', patchable: true, root, runtime, running: false, status: 'absent' })
  assert.equal(report.recommendedCarrier, 'sidebar')
  assert.equal(findDesktopInstall(base, none, none), undefined)
})

test('the DSH Tauri hosting this process wins over an official Desktop installed beside it', t => {
  const base = withBase(t)
  official(base)
  const { root, runtime, executable } = tauri(base)
  assert.equal(detectDesktopShell({ localAppData: base, registry: none, conventions: none, execPath: '/usr/bin/node' }).kind, 'official-supported')
  const running = detectDesktopShell({ localAppData: base, registry: none, conventions: none, execPath: executable })
  assert.deepEqual([running.kind, running.root, running.runtime, running.running], ['tauri', root, runtime, true])
  assert.deepEqual(runningTauriRuntime(executable), { root, runtime, identifier: 'dsh-tauri', appName: 'DSH Tauri', running: true })
})

test('another electron-rs app, or a runtime for another platform, is not DSH Tauri', t => {
  const base = withBase(t)
  const other = tauri(base, { identifier: 'someone-else' })
  assert.equal(runningTauriRuntime(other.executable), undefined)
  assert.equal(findTauriRuntime({ execPath: '/usr/bin/node', localAppData: base, registry: none }), undefined)
  const foreign = withBase(t)
  tauri(foreign, { target: process.platform === 'win32' ? 'darwin' : 'win32' })
  assert.equal(findTauriRuntime({ execPath: '/usr/bin/node', localAppData: foreign, registry: none }), undefined)
  assert.equal(detectDesktopShell({ localAppData: foreign, registry: none, conventions: none, execPath: '/usr/bin/node' }).kind, 'none')
})

test('a registry InstallLocation written in quotes (the DSH Tauri NSIS installer) is unquoted', () => {
  const query = (_command, args) => {
    assert.equal(args[4], 'DSH Tauri')
    return '\r\nHKEY_CURRENT_USER\\...\\DSH Tauri\r\n    InstallLocation    REG_SZ    "C:\\Users\\me\\AppData\\Local\\DSH Tauri"\r\n'
  }
  assert.deepEqual([...new Set(registeredInstallLocations('win32', query, 'DSH Tauri'))], ['C:\\Users\\me\\AppData\\Local\\DSH Tauri'])
})

test('the sidebar on a running DSH Tauri is ready once its host patch runs the bridge, not before', () => {
  const status = (endpoint, hostPatch = 'applied') => readRuntimeStatus({
    channel: () => 'sidebar', hasBinary: () => false, provision: () => ({ state: 'idle', detail: '' }),
    bridge: () => undefined, endpoint: () => endpoint,
    shell: () => ({ kind: 'tauri', patchable: true, reason: 'DSH Tauri', recommendedCarrier: 'sidebar', running: true, hostPatch: { status: hostPatch } }),
  })
  const live = { alive: true, detail: 'bridge endpoint answered' }
  assert.equal(status(live).resolvedCarrier, 'sidebar')
  assert.equal(status(live).readiness, 'ready')
  assert.equal(status(live).shell.kind, 'tauri')
  assert.equal(status(undefined).readiness, 'blocked')
  assert.equal(status(live, 'absent').readiness, 'blocked')
})

test('on macOS the running Electron binary inside <runtime>/<name>.app is recognised', t => {
  const base = withBase(t)
  const root = join(base, 'DSH Tauri.app')
  const runtime = join(root, 'Contents', 'Resources', 'runtime', 'darwin-arm64')
  mkdirSync(join(runtime, 'DSH Tauri.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(runtime, 'electron-rs.json'), JSON.stringify({ appName: 'DSH Tauri', identifier: 'dsh-tauri', target: 'darwin', arch: 'arm64', version: 2 }))
  const executable = join(runtime, 'DSH Tauri.app', 'Contents', 'MacOS', 'DSH Tauri')
  assert.deepEqual(runningTauriRuntime(executable), { root, runtime, identifier: 'dsh-tauri', appName: 'DSH Tauri', running: true })
})
