// Maintenance refuses a running target and never terminates its host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
const script = fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url))
const source = readFileSync(script, 'utf8')

test('maintenance has no host termination or installer handoff path', () => {
  assert.doesNotMatch(source, /taskkill|stopShell|DSH_CHILD_OF_SHELL'\s*&&|--detached|DSH_BRIDGE_HANDOFF_PARENT/)
  const guard = source.indexOf('if (shellProcesses(installRoot).length !== 0)')
  const mutations = source.indexOf('const packedLayout = existsSync(asarPath)')
  assert.ok(guard > 0 && guard < mutations)
})

test('the process query is hidden and fails closed', () => {
  const start = source.indexOf('function runCapture(')
  const end = source.indexOf('\n/**', start)
  let options
  const capture = runInNewContext(source.slice(start, end) + '; runCapture', {
    execFileSync(_command, _args, actual) { options = actual; throw Error('unavailable') },
  })
  assert.equal(capture('powershell.exe', []), undefined)
  assert.equal(options.windowsHide, true)
  assert.equal(options.encoding, 'utf8')
})

test('test mode never launches a Desktop executable', () => {
  const start = source.indexOf('function startShell')
  const end = source.indexOf('\nconst args =', start)
  let spawns = 0
  const launch = runInNewContext(source.slice(start, end) + '; startShell', {
    join: (...parts) => parts.join('/'), existsSync: () => true,
    process: { env: { DSH_BROWSER_TEST: '1' } }, console: { error() {}, log() {} },
    spawn() { spawns++; throw Error('must not spawn') },
  })
  assert.equal(launch('fake-desktop'), false)
  assert.equal(spawns, 0)
})

function isolatedInstall() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-safety-'))
  writeFileSync(join(root, '.dsh-bridge-test-root'), 'dsh-browser-installer-test-root-v1\n')
  const target = join(root, 'desktop'), main = join(target, 'resources', 'app', 'lib', 'main.js')
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(join(target, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-test', main: 'lib/main.js' }))
  const original = 'const app = {};\nexport {};\n'
  writeFileSync(main, original)
  return { root, target, main, original, close() {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('dsh-installer-safety-'))
    rmSync(root, { recursive: true, force: true })
  } }
}

for (const ancestor of [false, true]) {
  test(`a real installer invocation refuses ${ancestor ? 'GUI ancestry' : 'a running Desktop'} without modifying files`, () => {
    const check = isolatedInstall()
    try {
      const preload = join(check.root, 'process-fixture.cjs')
      writeFileSync(preload, `const cp=require('node:child_process');const exe=${JSON.stringify(join(check.target, 'DeepSeek Harness.exe'))};
cp.execFileSync=(command)=>{if(command!=='powershell.exe')throw Error('unexpected process invocation');return JSON.stringify([
{ProcessId:${ancestor ? 'process.ppid' : '987654'},ParentProcessId:1,Name:'DeepSeek Harness.exe',ExecutablePath:exe,CommandLine:JSON.stringify(exe)},
{ProcessId:process.pid,ParentProcessId:${ancestor ? 'process.ppid' : '1'},Name:'node.exe',ExecutablePath:process.execPath,CommandLine:'node install.mjs'}])};
require('node:module').syncBuiltinESMExports();`)
      const result = spawnSync(process.execPath, ['--require', preload, script, check.target, '--restart', '--yes', '--detached'], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
        env: { ...process.env, DSH_BROWSER_TEST: '1', DSH_BRIDGE_TEST_ROOT: check.root },
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, ancestor ? /child of DSH Desktop/ : /DSH Desktop is running/)
      assert.equal(readFileSync(check.main, 'utf8'), check.original)
      assert.equal(existsSync(check.main + '.before-bridge'), false)
      assert.equal(existsSync(join(dirname(check.main), 'plugin-browser-bridge.js')), false)
    } finally { check.close() }
  })
}

test('closed-target maintenance completes with an explicit no-restart result', () => {
  const check = isolatedInstall()
  try {
    const preload = join(check.root, 'closed-fixture.cjs'), resultFile = join(check.target, 'result.json')
    writeFileSync(preload, "require('node:child_process').execFileSync=()=>JSON.stringify([{ProcessId:process.pid,ParentProcessId:1,Name:'node.exe'}]);require('node:module').syncBuiltinESMExports();")
    const result = spawnSync(process.execPath, ['--require', preload, script, check.target], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, DSH_BROWSER_TEST: '1', DSH_BRIDGE_TEST_ROOT: check.root, DSH_BRIDGE_ACTION_RESULT_FILE: resultFile },
    })
    assert.equal(result.status, 0, result.stderr)
    const reported = JSON.parse(readFileSync(resultFile, 'utf8'))
    assert.equal(reported.ok, true)
    assert.equal(reported.restarted, false)
    assert.equal(reported.pid, undefined)
  } finally { check.close() }
})
// Execute the actual selection function with process tables that would previously kill native
// CLI/installer processes. The real process table and running desktop are never modified.
function processSelection() {
  const start = source.indexOf('function selectShellProcesses')
  const end = source.indexOf('/**\n * Run a command and return its stdout', start)
  return source.slice(start, end)
}

test('the selected GUI processes exclude native CLI, installer and other installations', () => {
  const root = resolve('test-desktop')
  const exe = resolve(root, 'DeepSeek Harness.exe')
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  const row = (pid, parent, commandLine, executablePath = exe) => ({
    ProcessId: pid, ParentProcessId: parent, Name: 'DeepSeek Harness.exe', ExecutablePath: executablePath, CommandLine: commandLine,
  })
  const selected = select([
    row(10, 1, '"' + exe + '"'),
    row(11, 10, '"' + exe + '" --type=renderer'),
    row(20, 1, '"' + exe + '" --expose-internals "resources/app.asar/cli.js"'),
    row(21, 20, '"' + exe + '" "desktop-bridge/install.mjs" --restart'),
    row(30, 1, '"' + exe + '" --eval "console.log(1)"'),
    row(40, 1, '"other/DeepSeek Harness.exe"', resolve('other-desktop', 'DeepSeek Harness.exe')),
  ], root, 21)
  assert.deepEqual(Array.from(selected), [10, 11])
})

test('an installer beneath the GUI refuses before any GUI process can be closed', () => {
  const root = resolve('test-desktop')
  const exe = resolve(root, 'DeepSeek Harness.exe')
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '"' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '" --expose-internals cli.js' },
    { ProcessId: 21, ParentProcessId: 20, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '" install.mjs --restart' },
  ]
  assert.throws(() => select(rows, root, 21), /separate terminal with Node.js/)
})

test('failed or malformed process enumeration never means the GUI is stopped', () => {
  const root = resolve('test-desktop')
  for (const output of [undefined, '', 'not json', 'null', '[]', '{}', '[null]']) {
    const enumerate = runInNewContext(processSelection() + '; shellProcesses', {
      resolve, process: { pid: 21 }, runCapture: () => output,
    })
    assert.throws(() => enumerate(root), /process|enumerate|parse|invalid/i)
  }
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  assert.throws(() => select([
    { ProcessId: 10, ParentProcessId: 1, Name: 'DeepSeek Harness.exe', ExecutablePath: null, CommandLine: null },
  ], root, 21), /could not identify/)
})

test('the process query declares UTF-8 before matching Unicode installation paths', () => {
  const root = resolve('桌面安装目录')
  const exe = resolve(root, 'DeepSeek Harness.exe')
  let query
  const enumerate = runInNewContext(processSelection() + '; shellProcesses', {
    resolve, process: { pid: 999 },
    runCapture: (command, args) => {
      assert.equal(command, 'powershell.exe')
      query = args.at(-1)
      return JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '"' }])
    },
  })
  assert.deepEqual(Array.from(enumerate(root)), [10])
  assert.match(query, /^\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false\);/,
    'a GUI-launched Windows PowerShell otherwise emits CP936 bytes that UTF-8 decoding corrupts')
})

test('GUI restart clears Electron Node mode while retaining the remaining environment', () => {
  const start = source.indexOf('function startShell')
  const end = source.indexOf('\nconst args =', start)
  let options
  let detached = false
  const environment = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', RETAINED_TEST_SETTING: 'retained',
    DSH_BRIDGE_DETACHED: '1', DSH_BRIDGE_HANDOFF_PARENT: '21',
    DSH_BRIDGE_ACTION_RESULT_FILE: 'private-result.json', DSH_BRIDGE_ACTION_LOG_FILE: 'private-log.txt' }
  const startGui = runInNewContext(source.slice(start, end) + '; startShell', {
    join: (...parts) => parts.join('/'),
    existsSync: () => true,
    process: { env: environment },
    console: { log() {}, error() {} },
    spawn: (_exe, _argv, config) => {
      options = config
      return { pid: 123, on() {}, unref() { detached = true } }
    },
  })
  assert.equal(startGui('test-desktop'), true)
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(options.env.electron_run_as_node, undefined)
  assert.equal(options.env.RETAINED_TEST_SETTING, 'retained')
  assert.equal(Object.keys(options.env).some(key => key.startsWith('DSH_BRIDGE_')), false, 'installer handoff state cannot poison the next reinstall')
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1', 'the parent host remains in its original mode')
  assert.equal(options.detached, true)
  assert.equal(detached, true)
})
