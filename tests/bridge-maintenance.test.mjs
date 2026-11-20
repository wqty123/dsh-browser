import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareBridgeMaintenance } from '../lib/browser-electron/bridge-maintenance.js'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'

function fixture() {
  const sandbox = createInstallerSandbox()
  const target = join(sandbox.temp('desktop-'), 'DSH space %VALUE% & ! 中文')
  mkdirSync(join(target, 'resources', 'app', 'lib'), { recursive: true })
  const main = join(target, 'resources', 'app', 'lib', 'main.js')
  writeFileSync(main, 'const app = {};\nexport {};\n')
  writeFileSync(join(target, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-test', main: 'lib/main.js' }))
  const directory = join(sandbox.root, 'prepared %PATH% & ! 中文')
  const options = { directory, nodePath: process.execPath }
  return { sandbox, target, main, directory, options }
}

test('preparation writes a launcher and literal plan without changing the target installation', async () => {
  const check = fixture()
  try {
    const before = readFileSync(check.main, 'utf8')
    const prepared = await prepareBridgeMaintenance('install', check.target, check.options)
    assert.equal(prepared.ok, true)
    assert.equal(prepared.prepared, true)
    assert.equal(prepared.action, 'install')
    assert.ok(prepared.path.endsWith('install-bridge.cmd'))
    assert.deepEqual(readdirSync(prepared.directory).sort(), ['install-bridge.cmd', 'maintenance.json', 'run-maintenance.mjs'])
    const plan = JSON.parse(readFileSync(prepared.planPath, 'utf8'))
    assert.equal(plan.installRoot, check.target)
    assert.equal(plan.nodePath, process.execPath)
    assert.equal(plan.action, 'install')
    assert.equal(plan.electronNode, false)
    assert.equal(readFileSync(check.main, 'utf8'), before)
    assert.equal(existsSync(check.main + '.before-bridge'), false)
    assert.equal(existsSync(join(check.target, 'resources', 'app', 'lib', 'plugin-browser-bridge.js')), false)
    assert.equal(prepared.commandShell, 'powershell')
    assert.ok(prepared.command.startsWith("& '"))
  } finally { check.sandbox.close() }
})

test('offline command preserves exit code, allows automated no-pause and has no host restart command', async () => {
  const check = fixture()
  try {
    const prepared = await prepareBridgeMaintenance('uninstall', check.target, check.options)
    const batch = readFileSync(prepared.path, 'utf8')
    const runner = readFileSync(prepared.runnerPath, 'utf8')
    assert.equal(JSON.parse(readFileSync(prepared.planPath, 'utf8')).action, 'uninstall')
    assert.match(batch, /setlocal DisableDelayedExpansion/)
    assert.match(batch, /chcp 65001 >nul/)
    assert.match(batch, /DSH_BRIDGE_MAINTENANCE_NO_PAUSE/)
    assert.match(batch, /exit \/b %DSH_BRIDGE_MAINTENANCE_EXIT%/)
    assert.doesNotMatch(batch + runner, /taskkill|--restart|--yes|Start-Process|schtasks|setInterval|setTimeout/)
    assert.match(runner, /shell: false/)
    assert.match(runner, /\['--revert'\]/)
    assert.match(runner, /environment\.NODE_TEST_CONTEXT/)
    assert.equal(batch.includes(check.target), false, 'shell-sensitive target text lives only in JSON')
  } finally { check.sandbox.close() }
})

test('each preparation creates immutable distinct files', async () => {
  const check = fixture()
  try {
    const first = await prepareBridgeMaintenance('install', check.target, check.options)
    const bytes = readFileSync(first.planPath, 'utf8')
    const second = await prepareBridgeMaintenance('uninstall', check.target, check.options)
    assert.notEqual(first.directory, second.directory)
    assert.equal(readFileSync(first.planPath, 'utf8'), bytes)
  } finally { check.sandbox.close() }
})

test('another application or unknown action is refused before writing a launcher', async () => {
  const check = fixture()
  try {
    await assert.rejects(prepareBridgeMaintenance('restart', check.target, check.options), /action must be install or uninstall/)
    writeFileSync(join(check.target, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'unrelated-app' }))
    await assert.rejects(prepareBridgeMaintenance('install', check.target, check.options), /cannot prepare bridge maintenance/)
    assert.equal(existsSync(check.directory), false)
  } finally { check.sandbox.close() }
})

test('Electron fallback is tied to the verified Desktop and isolated to the launcher environment', async () => {
  const check = fixture()
  try {
    const runtime = join(check.target, 'DeepSeek Harness.exe')
    writeFileSync(runtime, 'fixture executable, never run')
    const before = process.env.ELECTRON_RUN_AS_NODE
    const prepared = await prepareBridgeMaintenance('install', check.target, { directory: check.directory, nodePath: runtime })
    const plan = JSON.parse(readFileSync(prepared.planPath, 'utf8'))
    assert.equal(plan.electronNode, true)
    assert.equal(plan.nodePath, runtime)
    const batch = readFileSync(prepared.path, 'utf8')
    assert.match(batch, /set "ELECTRON_RUN_AS_NODE=1"/)
    assert.match(batch, /--expose-internals/)
    assert.ok(batch.includes(runtime.replace(/%/g, '%%')))
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, before, 'preparing never changes the host environment')
    const unrelated = join(check.sandbox.root, 'unrelated.exe')
    writeFileSync(unrelated, 'never run')
    await assert.rejects(prepareBridgeMaintenance('install', check.target, { directory: check.directory, nodePath: unrelated }), /must belong to the verified Desktop/)
  } finally { check.sandbox.close() }
})

test('quotes and control characters in runtime paths cannot become batch text', async () => {
  const check = fixture()
  try {
    for (const fragment of ['bad"name.exe', 'bad\rname.exe', 'bad\nname.exe', 'bad\0name.exe']) {
      await assert.rejects(prepareBridgeMaintenance('install', check.target, { directory: check.directory, nodePath: join(check.sandbox.root, fragment) }), /quotes or control characters/)
    }
    assert.equal(existsSync(check.directory), false)
  } finally { check.sandbox.close() }
})

test('preparation cannot store its files inside the verified installation', async () => {
  const check = fixture()
  try {
    const directory = join(check.target, 'generated-maintenance')
    await assert.rejects(prepareBridgeMaintenance('install', check.target, { directory, nodePath: process.execPath }), /outside the Desktop installation/)
    assert.equal(existsSync(directory), false)
  } finally { check.sandbox.close() }
})

test('a redirected output directory is refused before creating anything in Desktop', async t => {
  const check = fixture()
  const link = join(check.sandbox.root, 'redirected')
  try {
    try { symlinkSync(check.target, link, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { t.skip(`directory links unavailable: ${error.code}`); return }
    await assert.rejects(prepareBridgeMaintenance('install', check.target, { directory: join(link, 'maintenance'), nodePath: process.execPath }), /outside the Desktop installation/)
    assert.equal(existsSync(join(check.target, 'maintenance')), false)
  } finally {
    if (existsSync(link)) unlinkSync(link)
    check.sandbox.close()
  }
})
