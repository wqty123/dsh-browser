// The bridge install/uninstall button: the argv it runs and what it reports.
//
// The panel used to hand the user a command line. For a step that closes and reopens the desktop app,
// "copy this into a terminal" is where the user gets stuck, so the panel now runs the packaged
// installer itself. These tests pin the two things that can silently go wrong: the argument list
// (a missing --restart leaves the shell holding app.asar, and the install fails with EBUSY) and the
// mapping from exit code to the sentence the user reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bridgeActionArgv, runBridgeAction } from '../lib/browser-electron/bridge-install.js'

/** Effects that record the call and answer with a chosen result. */
function deps(answer = { code: 0, output: 'installed' }) {
  const calls = []
  return {
    calls,
    deps: {
      // The action now preflights identity first; the fake answers that call separately so the
      // install assertion below still sees exactly what the installer would get.
      run: async (command, argv) => {
        calls.push({ command, argv })
        if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true,"layout":"packed","packageName":"@deepseek-ai/dsh-desktop"}' }
        return answer
      },
      installer: () => 'C:\\pkg\\desktop-bridge\\install.mjs',
      node: () => 'C:\\node\\node.exe',
    },
  }
}

test('install runs the packaged installer unattended, with a restart', () => {
  assert.deepEqual(bridgeActionArgv('install', 'C:\\DSH Desktop'), ['C:\\DSH Desktop', '--restart', '--yes'])
})

test('uninstall reverts first, then restarts', () => {
  assert.deepEqual(bridgeActionArgv('uninstall', 'C:\\DSH Desktop'), ['C:\\DSH Desktop', '--revert', '--restart', '--yes'])
})

test('a successful run reports ok with the code and the command it ran', async () => {
  const built = deps({ code: 0, output: 'bridge installed' })
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  // The path has a space, so it is quoted for a human to copy — that is the whole point of printing it.
  assert.ok(result.command.includes('"C:\\DSH Desktop"'), `quoted path in: ${result.command}`)
  assert.ok(result.command.endsWith('--restart --yes'), 'and the flags a user can reproduce')
  assert.equal(built.calls.length, 2, 'one preflight, then the install')
  assert.deepEqual(built.calls[0].argv.slice(1), ['C:\\DSH Desktop', '--preflight'])
  assert.deepEqual(built.calls[1].argv.slice(1), ['C:\\DSH Desktop', '--restart', '--yes'])
})

test('a failed run keeps the exit code and the tail of the output', async () => {
  const built = deps({ code: 1, output: 'EBUSY: resource busy or locked, rename app.asar' })
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
  assert.equal(result.ok, false)
  assert.equal(result.code, 1)
  assert.match(result.output, /EBUSY/)
})

test('an installer that cannot even start is a result, not an exception', async () => {
  const built = deps()
  built.deps.run = async () => { throw new Error('spawn ENOENT') }
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
  assert.equal(result.ok, false)
  assert.equal(result.code, null)
  assert.match(result.output, /spawn ENOENT/)
})

test('a very long output is trimmed from the front, because the failure is at the end', async () => {
  const long = 'x'.repeat(5_000) + ' THE-REAL-ERROR'
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', deps({ code: 1, output: long }).deps)
  assert.match(result.output, /THE-REAL-ERROR/)
  assert.ok(result.output.length < 700, 'the panel gets a line, not a log')
})

test('a refused preflight stops before anything is changed', async () => {
  const calls = []
  const built = {
    run: async (command, argv) => {
      calls.push(argv)
      return { code: 1, output: '{"ok":false,"reason":"resources/app.asar exists but its package.json cannot be read"}' }
    },
    installer: () => 'C:\\pkg\\desktop-bridge\\install.mjs',
    node: () => 'C:\\node\\node.exe',
  }
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', built)
  assert.equal(result.ok, false)
  assert.match(result.output, /package\.json cannot be read/, 'the reason is what the user reads')
  assert.equal(calls.length, 1, 'and the install never ran')
  assert.ok(calls[0].includes('--preflight'))
})
