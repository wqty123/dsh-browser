import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { commitAutomaticMaintenance, maintenanceProgressLaunchOptions, readAutomaticMaintenance, startAutomaticMaintenance, startMaintenanceProgressNotification } from '../lib/browser-electron/automatic-maintenance.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-automatic-maintenance-'))
  t.after(() => {
    assert.equal(dirname(directory), tmpdir())
    rmSync(directory, { recursive: true, force: true })
  })
  const home = join(directory, 'home')
  const root = join(directory, 'desktop')
  const id = 'install-test123'
  const base = join(home, 'dsh-builtin-browser-host', 'maintenance')
  const jobDirectory = join(base, id)
  mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(root, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', main: 'lib/main.js', type: 'module' }))
  writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), '// private identity fixture')
  mkdirSync(jobDirectory, { recursive: true })
  const plan = {
    version: 1, id, action: 'install', root, nodePath: process.execPath, electronNode: false, home,
    directory: jobDirectory, target: { pid: 1234, path: join(root, 'DeepSeek Harness.exe'), command: '"DeepSeek Harness.exe"', started: new Date(Date.now() - 1_000).toISOString() },
    createdAt: new Date().toISOString(),
  }
  const state = { id, action: 'install', phase: 'armed', workerPid: 5678, at: new Date().toISOString() }
  const save = () => {
    writeFileSync(join(jobDirectory, 'automatic.json'), JSON.stringify(plan))
    writeFileSync(join(jobDirectory, 'state.json'), JSON.stringify(state))
    writeFileSync(join(base, 'latest.json'), JSON.stringify({ id, directory: jobDirectory }))
  }
  save()
  return { directory, home, root, id, base, jobDirectory, plan, state, save }
}

test('an automatic launch is prohibited in the test process before discovery or broker creation', async () => {
  await assert.rejects(startAutomaticMaintenance('install', 'C:/not-a-real-target'), /forbidden in a test process|requires Windows Desktop/)
})

test('committing the current armed job writes a process-bound permission without changing its phase', async t => {
  const f = fixture(t)
  assert.equal(readAutomaticMaintenance(f.home)?.phase, 'armed')
  assert.equal(existsSync(join(f.jobDirectory, 'commit.json')), false)
  await commitAutomaticMaintenance(f.id, f.home)
  const commit = JSON.parse(readFileSync(join(f.jobDirectory, 'commit.json'), 'utf8'))
  assert.equal(commit.id, f.id)
  assert.equal(commit.workerPid, f.state.workerPid)
  assert.ok(Number.isFinite(Date.parse(commit.at)))
  assert.equal(readAutomaticMaintenance(f.home)?.phase, 'armed', 'only the independent worker moves the lifecycle forward')
  await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /EEXIST/, 'a second commit cannot overwrite the permission')
})

test('a different, finished, cancelled or malformed job cannot be committed', async t => {
  const f = fixture(t)
  await assert.rejects(commitAutomaticMaintenance('../escape', f.home), /invalid.*id/)
  await assert.rejects(commitAutomaticMaintenance('install-another123', f.home), /no longer armed/)
  f.state.phase = 'completed'
  f.save()
  await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /no longer armed/)
  f.state.phase = 'armed'
  f.state.workerPid = -1
  f.save()
  await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /no longer armed/)
  f.state.workerPid = 5678
  f.save()
  writeFileSync(join(f.jobDirectory, 'cancel.json'), '{}')
  await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /cannot be committed/)
  assert.equal(existsSync(join(f.jobDirectory, 'commit.json')), false)
})

test('expired, invalid and future plan creation times do not authorize a quit', async t => {
  const f = fixture(t)
  for (const createdAt of ['invalid', new Date(Date.now() - 31_000).toISOString(), new Date(Date.now() + 60_000).toISOString()]) {
    f.plan.createdAt = createdAt
    f.save()
    await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /invalid or expired/)
  }
  assert.equal(existsSync(join(f.jobDirectory, 'commit.json')), false)
})

test('a plan cannot redirect the job to another executable, process role or directory', async t => {
  const f = fixture(t)
  const original = structuredClone(f.plan)
  const mutations = [
    plan => { plan.target.path = join(f.directory, 'other', 'DeepSeek Harness.exe') },
    plan => { plan.target.pid = 0 },
    plan => { plan.target.started = 'invalid' },
    plan => { plan.target.command += ' --type=renderer' },
    plan => { plan.directory = f.directory },
    plan => { plan.electronNode = 'yes' },
    plan => { plan.action = 'uninstall' },
    plan => { plan.locale = 'invalid' },
  ]
  for (const mutate of mutations) {
    Object.assign(f.plan, structuredClone(original))
    mutate(f.plan)
    f.save()
    await assert.rejects(commitAutomaticMaintenance(f.id, f.home), /invalid/)
  }
  assert.equal(existsSync(join(f.jobDirectory, 'commit.json')), false)
})

test('the durable status reader rejects a latest pointer outside its maintenance directory', t => {
  const f = fixture(t)
  writeFileSync(join(f.base, 'latest.json'), JSON.stringify({ id: f.id, directory: join(f.directory, f.id) }))
  assert.equal(readAutomaticMaintenance(f.home), undefined)
})

test('the independent progress launch is a read-only localized PowerShell request', t => {
  const f = fixture(t)
  const request = maintenanceProgressLaunchOptions(f.id, f.jobDirectory, 'en', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  assert.equal(request.runtimePath, 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  assert.equal(request.cwd, f.jobDirectory)
  assert.deepEqual(request.environment, { ELECTRON_RUN_AS_NODE: undefined })
  assert.deepEqual(request.args.slice(0, 8), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', request.args[7]])
  assert.match(request.args[7], /[\\/]desktop-bridge[\\/]maintenance-progress\.ps1$/)
  assert.deepEqual(request.args.slice(8), ['-StatePath', join(f.jobDirectory, 'state.json'), '-JobId', f.id, '-Locale', 'en'])
  assert.doesNotMatch(request.args.join(' '), /request-desktop-quit|install\.mjs|--restart|taskkill/)
  const defaultLocale = maintenanceProgressLaunchOptions(f.id, f.jobDirectory, undefined, request.runtimePath)
  assert.equal(defaultLocale.args.at(-1), 'zh')
})

test('the progress notification is attempted once and keeps diagnostics separate from maintenance state', async t => {
  const f = fixture(t)
  const before = readFileSync(join(f.jobDirectory, 'state.json'), 'utf8')
  const electronBefore = process.env.ELECTRON_RUN_AS_NODE
  let calls = 0
  const deps = {
    powershellPath: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    helperExists: () => true,
    launch: async options => {
      calls += 1
      assert.equal(options.environment.ELECTRON_RUN_AS_NODE, undefined)
      assert.equal(options.args.at(-1), 'en')
      return { pid: 2468 }
    },
  }
  const result = await startMaintenanceProgressNotification({ jobId: f.id, directory: f.jobDirectory, locale: 'en' }, deps)
  assert.equal(result.started, true)
  assert.equal(result.pid, 2468)
  const duplicate = await startMaintenanceProgressNotification({ jobId: f.id, directory: f.jobDirectory }, deps)
  assert.equal(duplicate.skipped, true)
  assert.equal(calls, 1)
  assert.equal(readFileSync(join(f.jobDirectory, 'state.json'), 'utf8'), before)
  assert.equal(JSON.parse(readFileSync(join(f.jobDirectory, 'progress-notification.json'), 'utf8')).pid, 2468)
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, electronBefore)
})

test('a denied or missing progress window is diagnostic only and does not reject the maintenance flow', async t => {
  for (const reason of ['denied', 'missing']) {
    const f = fixture(t)
    const stateBefore = readFileSync(join(f.jobDirectory, 'state.json'), 'utf8')
    let launches = 0
    const result = await startMaintenanceProgressNotification({ jobId: f.id, directory: f.jobDirectory }, {
      powershellPath: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      helperExists: () => reason !== 'missing',
      launch: async () => { launches += 1; throw new Error('WMI notification denied') },
    })
    assert.equal(result.started, false)
    assert.match(result.error, reason === 'missing' ? /progress window is unavailable/ : /notification denied/)
    assert.equal(launches, reason === 'missing' ? 0 : 1)
    assert.equal(readFileSync(join(f.jobDirectory, 'state.json'), 'utf8'), stateBefore)
    assert.equal(JSON.parse(readFileSync(join(f.jobDirectory, 'progress-notification.json'), 'utf8')).started, false)
  }
})

test('progress diagnostic I/O failure is swallowed and never launches a second notifier', async t => {
  const f = fixture(t)
  mkdirSync(join(f.jobDirectory, 'progress-notification.json'))
  const result = await startMaintenanceProgressNotification({ jobId: f.id, directory: f.jobDirectory }, {
    powershellPath: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', helperExists: () => true,
    launch: async () => { throw new Error('notification failed') },
  })
  assert.equal(result.started, false)
  assert.match(result.error, /notification failed/)
})

test('the real notification broker remains disabled in the test process', async t => {
  const f = fixture(t)
  const result = await startMaintenanceProgressNotification({ jobId: f.id, directory: f.jobDirectory }, {
    powershellPath: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', helperExists: () => true,
  })
  assert.equal(result.started, false)
  assert.match(result.error, /disabled in tests/)
})
