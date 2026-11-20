// The bridge install/uninstall button: the argv it runs and what it reports.
//
// Panel maintenance runs only after the target Desktop has exited. Argument and completion checks
// keep the panel from requesting a restart or accepting an unexpected restart as successful work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'

import { bridgeActionArgv, runBridgeAction, waitForBridgeActionCompletion, waitForRestartedBridge } from '../lib/browser-electron/bridge-install.js'

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

test('panel installation never requests Desktop shutdown or restart', () => {
  assert.deepEqual(bridgeActionArgv('install', 'C:\\DSH Desktop'), ['C:\\DSH Desktop'])
})

test('panel uninstall only requests the file revert', () => {
  assert.deepEqual(bridgeActionArgv('uninstall', 'C:\\DSH Desktop'), ['C:\\DSH Desktop', '--revert'])
})

test('a successful run reports ok with the code and the command it ran', async () => {
  const built = deps({ code: 0, output: 'bridge installed' })
  const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  // The path has a space, so it is quoted for a human to copy — that is the whole point of printing it.
  assert.ok(result.command.includes('"C:\\DSH Desktop"'), `quoted path in: ${result.command}`)
  assert.doesNotMatch(result.command, /--restart|--yes|--detached/, 'the panel cannot request host shutdown')
  assert.equal(built.calls.length, 2, 'one preflight, then the install')
  assert.deepEqual(built.calls[0].argv.slice(1), ['C:\\DSH Desktop', '--preflight'])
  assert.deepEqual(built.calls[1].argv.slice(1), ['C:\\DSH Desktop'])
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

/** Remove only the private temporary directory made for this test's completion record. */
function removeJob(resultFile) {
  const directory = resolve(dirname(resultFile))
  assert.equal(dirname(directory).toLowerCase(), resolve(tmpdir()).toLowerCase())
  assert.match(basename(directory), /^dsh-bridge-action-/)
  rmSync(directory, { recursive: true, force: true })
}

function completion(overrides = {}) {
  return { ok: true, code: 0, action: 'install', restarted: false, completedAt: new Date().toISOString(), ...overrides }
}

test('exit zero waits for the actual file-operation completion without leaking its environment', async () => {
  const calls = []
  let published = false
  let environment
  const before = process.env.DSH_BRIDGE_ACTION_RESULT_FILE
  const built = deps()
  built.deps.trackResult = true
  built.deps.resultTimeoutMs = 1000
  built.deps.resultPollMs = 5
  built.deps.run = async (command, argv, overrides) => {
    calls.push({ command, argv, overrides })
    if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true}' }
    environment = overrides
    setTimeout(() => {
      writeFileSync(overrides.DSH_BRIDGE_ACTION_LOG_FILE, 'file maintenance completed')
      writeFileSync(overrides.DSH_BRIDGE_ACTION_RESULT_FILE, JSON.stringify(completion()))
      published = true
    }, 35)
    return { code: 0, output: 'file maintenance finished' }
  }
  try {
    const task = runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(published, false, 'the actual installer has not completed yet')
    const result = await task
    assert.equal(published, true, 'the caller waits for final completion')
    assert.equal(result.ok, true)
    assert.equal(result.restarted, false)
    assert.equal(result.pid, undefined)
    assert.equal(result.resultFile, environment.DSH_BRIDGE_ACTION_RESULT_FILE)
    assert.equal(calls[0].overrides, undefined, 'the read-only preflight has no result environment')
    assert.equal(process.env.DSH_BRIDGE_ACTION_RESULT_FILE, before, 'the hosting process environment is unchanged')
    assert.match(result.output, /file maintenance completed/)
  } finally { if (environment) removeJob(environment.DSH_BRIDGE_ACTION_RESULT_FILE) }
})

test('exit zero cannot hide an installer failure or its diagnostics', async () => {
  let environment
  const built = deps()
  Object.assign(built.deps, { trackResult: true, resultTimeoutMs: 1000, resultPollMs: 5 })
  built.deps.run = async (_command, argv, overrides) => {
    if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true}' }
    environment = overrides
    writeFileSync(overrides.DSH_BRIDGE_ACTION_LOG_FILE, 'archive replacement was refused')
    writeFileSync(overrides.DSH_BRIDGE_ACTION_RESULT_FILE, JSON.stringify(completion({ ok: false, code: 7, restarted: false, error: 'access denied to archive' })))
    return { code: 0, output: 'installer finished' }
  }
  try {
    const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
    assert.equal(result.ok, false)
    assert.equal(result.code, 7)
    assert.match(result.output, /archive replacement was refused/)
    assert.match(result.output, /access denied to archive/)
  } finally { if (environment) removeJob(environment.DSH_BRIDGE_ACTION_RESULT_FILE) }
})

test('an installer that never reports completion is a bounded failure', async () => {
  let environment
  const built = deps()
  Object.assign(built.deps, { trackResult: true, resultTimeoutMs: 30, resultPollMs: 5 })
  built.deps.run = async (_command, argv, overrides) => {
    if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true}' }
    environment = overrides
    return { code: 0, output: 'installer finished' }
  }
  try {
    const result = await runBridgeAction('install', 'C:\\DSH Desktop', built.deps)
    assert.equal(result.ok, false)
    assert.equal(result.code, null)
    assert.match(result.output, /did not report completion/)
    assert.ok(result.resultFile, 'the operation retains its unique diagnosis location')
  } finally { if (environment) removeJob(environment.DSH_BRIDGE_ACTION_RESULT_FILE) }
})

test('malformed or unrelated final records never count as completed installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-action-'))
  const path = join(directory, 'result.json')
  try {
    for (const record of ['{', 'null', JSON.stringify(completion({ action: 'uninstall' })), JSON.stringify(completion({ restarted: true })), JSON.stringify(completion({ code: '0' })), JSON.stringify(completion({ pid: -4 })), JSON.stringify(completion({ completedAt: 'yesterday' }))]) {
      writeFileSync(path, record)
      await assert.rejects(waitForBridgeActionCompletion(path, 'install', 30, 5), /completion record/)
    }
  } finally { removeJob(path) }
})

test('an uninstall completion matches the action without starting Desktop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-action-'))
  const path = join(directory, 'result.json')
  try {
    const final = completion({ action: 'uninstall' })
    writeFileSync(path, JSON.stringify(final))
    assert.deepEqual(await waitForBridgeActionCompletion(path, 'uninstall', 30, 5), final)
  } finally { removeJob(path) }
})

test('panel completion rejects a reported restarted Desktop PID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-action-'))
  const path = join(directory, 'result.json')
  try {
    writeFileSync(path, JSON.stringify(completion({ restarted: true, pid: process.pid })))
    await assert.rejects(waitForBridgeActionCompletion(path, 'install', 30, 5), /invalid completion record/)
  } finally { removeJob(path) }
})

/** A real authenticated loopback protocol peer; it implements no mutating operation. */
async function bridgePeer({ response = { ok: true, guests: [], sidebar: [] } } = {}) {
  const requests = []
  const sockets = new Set()
  const token = 'isolated-install-readiness-token'
  let observeFirstRequest
  const firstRequest = new Promise(resolve => { observeFirstRequest = resolve })
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', bytes => {
      buffer += String(bytes)
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const request = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (!request.op) continue
        requests.push(request.op)
        const authenticated = request.token === token
        observeFirstRequest({ operation: request.op, authenticated })
        const answer = authenticated ? response : { ok: false, error: 'unauthorized' }
        socket.write(JSON.stringify({ ...answer, bridgeRequestId: request.bridgeRequestId }) + '\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-action-'))
  const path = join(directory, 'endpoint.json')
  return {
    requests, firstRequest, path, endpoint: { port: server.address().port, token, pid: process.pid },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      removeJob(path)
    },
  }
}

test('restart readiness waits for the new process endpoint and authenticates a read-only list', async () => {
  const peer = await bridgePeer()
  let timer
  try {
    writeFileSync(peer.path, JSON.stringify({ ...peer.endpoint, pid: process.pid + 1 }))
    timer = setTimeout(() => writeFileSync(peer.path, JSON.stringify(peer.endpoint)), 35)
    const task = waitForRestartedBridge(process.pid, { endpointPath: peer.path, timeoutMs: 2000, pollMs: 10 })
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.deepEqual(peer.requests, [], 'the previous process endpoint cannot be accepted')
    await task
    assert.deepEqual(await peer.firstRequest, { operation: 'list', authenticated: true })
    assert.ok(peer.requests.length > 0)
    assert.ok(peer.requests.every(operation => operation === 'list'), 'startup verification never initializes or captures a page')
  } finally { clearTimeout(timer); await peer.close() }
})

test('another process endpoint times out without connecting to that bridge', async () => {
  const peer = await bridgePeer()
  try {
    writeFileSync(peer.path, JSON.stringify({ ...peer.endpoint, pid: process.pid + 1 }))
    await assert.rejects(waitForRestartedBridge(process.pid, { endpointPath: peer.path, timeoutMs: 35, pollMs: 5 }), /did not become ready/)
    assert.deepEqual(peer.requests, [])
  } finally { await peer.close() }
})

test('bridge readiness refuses invalid endpoints and failed authentication', async () => {
  const peer = await bridgePeer()
  try {
    for (const endpoint of [{ ...peer.endpoint, port: 65536 }, { ...peer.endpoint, token: '' }]) {
      writeFileSync(peer.path, JSON.stringify(endpoint))
      await assert.rejects(waitForRestartedBridge(process.pid, { endpointPath: peer.path, timeoutMs: 20, pollMs: 5 }), /did not become ready/)
    }
    assert.deepEqual(peer.requests, [], 'invalid endpoint fields are refused before a connection')
    writeFileSync(peer.path, JSON.stringify({ ...peer.endpoint, token: 'wrong-fixture-token' }))
    // Actual TCP/authentication needs an I/O budget under the full suite's process/CIM load.
    // The request barrier also proves that this exercises authentication, not just a timer.
    const rejected = assert.rejects(waitForRestartedBridge(process.pid, { endpointPath: peer.path, timeoutMs: 1000, pollMs: 20 }), error => {
      assert.match(error.message, /did not become ready/)
      assert.doesNotMatch(error.message, /wrong-fixture-token|isolated-install-readiness-token/)
      return true
    })
    const first = await Promise.race([
      peer.firstRequest,
      rejected.then(() => { throw new Error('readiness timed out before the fixture received an authentication request') }),
    ])
    assert.deepEqual(first, { operation: 'list', authenticated: false }, 'the fixture actually rejects the supplied credential')
    await rejected
    assert.ok(peer.requests.length > 0)
    assert.ok(peer.requests.every(operation => operation === 'list'))
  } finally { await peer.close() }
})

test('a socket that answers without the list schema does not establish bridge readiness', async () => {
  const peer = await bridgePeer({ response: { ok: true } })
  try {
    writeFileSync(peer.path, JSON.stringify(peer.endpoint))
    const rejected = assert.rejects(waitForRestartedBridge(process.pid, { endpointPath: peer.path, timeoutMs: 1000, pollMs: 20 }), /did not become ready/)
    const first = await Promise.race([
      peer.firstRequest,
      rejected.then(() => { throw new Error('readiness timed out before the fixture could answer with its invalid list schema') }),
    ])
    assert.deepEqual(first, { operation: 'list', authenticated: true })
    await rejected
  } finally { await peer.close() }
})

test('panel maintenance accepts completed file changes without starting or probing Desktop', async () => {
  for (const action of ['install', 'uninstall']) {
    let environment
    const probes = []
    const built = deps()
    Object.assign(built.deps, { trackResult: true, resultTimeoutMs: 1000, resultPollMs: 5,
      bridgeReady: async (pid, timeoutMs) => { probes.push({ pid, timeoutMs }) },
    })
    built.deps.run = async (_command, argv, overrides) => {
      if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true}' }
      environment = overrides
      writeFileSync(overrides.DSH_BRIDGE_ACTION_RESULT_FILE, JSON.stringify(completion({ action })))
      return { code: 0, output: 'completed' }
    }
    try {
      const result = await runBridgeAction(action, 'C:\\DSH Desktop', built.deps)
      assert.equal(result.ok, true)
      assert.equal(result.restarted, false)
      assert.equal(result.pid, undefined)
      assert.deepEqual(probes, [], 'a maintenance action cannot start or probe a restarted Desktop')
    } finally { if (environment) removeJob(environment.DSH_BRIDGE_ACTION_RESULT_FILE) }
  }
})
