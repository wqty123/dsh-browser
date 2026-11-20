import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launchMaintenanceBroker, quoteWin32Argument } from '../lib/browser-electron/maintenance-broker.js'

test('Windows arguments quote spaces, empty values, quotes and trailing backslashes', () => {
  const cases = [
    ['', '""'],
    ['plain', '"plain"'],
    ['two words', '"two words"'],
    ['a"b', String.raw`"a\"b"`],
    [String.raw`a\"b`, String.raw`"a\\\"b"`],
    ['C:\\ends with slash\\', '"C:\\ends with slash\\\\"'],
    ['%PATH% & ! $() ` 中文', '"%PATH% & ! $() ` 中文"'],
  ]
  for (const [input, expected] of cases) assert.equal(quoteWin32Argument(input), expected)
  assert.throws(() => quoteWin32Argument('x\0y'), /without NUL/)
})

test('the real broker is hard-refused inside the test runner before any path or process access', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node:test exposes the context used by the hard gate')
  await assert.rejects(launchMaintenanceBroker({
    runtimePath: 'C:/missing.exe', cwd: 'C:/missing', args: [],
    environment: { NODE_TEST_CONTEXT: undefined, DSH_BROWSER_TEST: undefined },
  }), /disabled in tests/)
})

test('non-Windows hosts get a concrete unsupported result', async () => {
  await assert.rejects(launchMaintenanceBroker({ runtimePath: 'C:/node.exe', cwd: 'C:/', args: [] }, {
    platform: 'linux', execFile: () => { throw new Error('must not execute') },
  }), /requires Windows/)
})

const windowsTest = (name, run) => test(name, { skip: process.platform !== 'win32' }, run)

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-broker-test-'))
  t.after(() => {
    assert.equal(dirname(directory), tmpdir())
    rmSync(directory, { recursive: true, force: true })
  })
  return { runtimePath: process.execPath, cwd: directory, args: [] }
}

windowsTest('the broker sends fixed PowerShell code with data-only paths and an explicit environment', async t => {
  const options = fixture(t)
  const previousElectron = process.env.ELECTRON_RUN_AS_NODE
  const input = ['space arg', 'a"b', 'C:\\tail\\', '& echo danger', '%PATH%', '中文']
  const answer = await launchMaintenanceBroker({
    ...options, args: input,
    environment: { electron_run_as_node: '1', BROKER_TEST_VALUE: '中文 & ! %PATH% $()', NODE_OPTIONS: undefined },
  }, { execFile: async (file, args, execution) => {
    assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    assert.match(script, /Win32_ProcessStartup -ClientOnly/)
    assert.match(script, /ShowWindow = \[uint16\]0/)
    assert.match(script, /EnvironmentVariables = \$environment/)
    assert.match(script, /CreateFlags = \[uint32\]1024/)
    assert.match(script, /Invoke-CimMethod -Namespace root\/cimv2 -ClassName Win32_Process -MethodName Create/)
    assert.doesNotMatch(script, /Start-Process|taskkill|schtasks|Invoke-Expression/)
    const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)
    assert.ok(payload)
    const plan = JSON.parse(Buffer.from(payload[1], 'base64').toString('utf8'))
    assert.equal(plan.cwd, options.cwd)
    assert.equal(plan.commandLine, [options.runtimePath, ...input].map(quoteWin32Argument).join(' '))
    assert.equal(execution.shell, false)
    assert.equal(execution.windowsHide, true)
    assert.equal(execution.encoding, 'utf8')
    assert.equal(execution.timeout, 30_000)
    assert.equal(execution.env.electron_run_as_node, '1')
    assert.equal(execution.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(execution.env.BROKER_TEST_VALUE, '中文 & ! %PATH% $()')
    assert.equal(execution.env.NODE_OPTIONS, undefined)
    // Windows env names are case-insensitive, but spreading process.env into a plain object is
    // not. The host may expose SYSTEMROOT or SystemRoot; assert the value under either casing.
    assert.equal(
      Object.entries(execution.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1],
      process.env.SystemRoot ?? process.env.SYSTEMROOT,
      'the Windows system root is inherited under whichever casing the host uses',
    )
    assert.equal(execution.env.NODE_TEST_CONTEXT, process.env.NODE_TEST_CONTEXT, 'fake execution preserves test markers')
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, previousElectron, 'the host environment stays unchanged')
    return { stdout: '\uFEFF{"code":0,"pid":1234}\r\n', stderr: '' }
  } })
  assert.deepEqual(answer, { pid: 1234 })
})

windowsTest('invalid paths, arguments and environment values are rejected before execution', async t => {
  const options = fixture(t)
  const never = { execFile: async () => { throw new Error('executor must not run') } }
  for (const runtimePath of ['node.exe', '\\node.exe', 'C:node.exe', 'C:/bad\0.exe', 'C:/a"b.exe']) {
    await assert.rejects(launchMaintenanceBroker({ ...options, runtimePath }, never), /fully qualified Windows path/)
  }
  await assert.rejects(launchMaintenanceBroker({ ...options, args: ['bad\0arg'] }, never), /without NUL/)
  await assert.rejects(launchMaintenanceBroker({ ...options, environment: { 'BAD=NAME': 'x' } }, never), /valid Windows environment/)
  await assert.rejects(launchMaintenanceBroker({ ...options, environment: { VALUE: 'bad\0value' } }, never), /valid Windows environment/)
  await assert.rejects(launchMaintenanceBroker({ ...options, runtimePath: options.cwd }, never), /not a file/)
  await assert.rejects(launchMaintenanceBroker({ ...options, cwd: options.runtimePath }, never), /not a directory/)
  await assert.rejects(launchMaintenanceBroker({ ...options, args: ['x'.repeat(32_767)] }, never), /command-line limit/)
  await assert.rejects(launchMaintenanceBroker({ ...options, args: ['x'.repeat(10_000)] }, never), /encoded maintenance broker command/)
})

windowsTest('WMI refusal codes are returned as concrete failures without alternate launch methods', async t => {
  const options = fixture(t)
  for (const code of [2, 3, 8, 9, 21]) {
    let calls = 0
    await assert.rejects(launchMaintenanceBroker(options, { execFile: async () => {
      calls += 1
      return { stdout: JSON.stringify({ code, pid: 0 }), stderr: '' }
    } }), new RegExp(`WMI code ${code}`))
    assert.equal(calls, 1)
  }
})

windowsTest('malformed broker answers and executor failures are not reported as a started process', async t => {
  const options = fixture(t)
  for (const stdout of ['', 'invalid', 'null', '[]', '{"pid":12}', '{"code":0}', '{"code":0,"pid":-1}']) {
    await assert.rejects(launchMaintenanceBroker(options, { execFile: async () => ({ stdout, stderr: '' }) }), /unreadable|invalid|no valid process id/)
  }
  await assert.rejects(launchMaintenanceBroker(options, { execFile: async () => { throw new Error('access denied by policy') } }), /access denied by policy/)
})
