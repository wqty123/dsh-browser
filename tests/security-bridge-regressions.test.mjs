import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const directory = mkdtempSync(join(tmpdir(), 'bridge-regressions-'))
const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
const stubbed = source.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__')
const contents = []
const closed = []
globalThis.__electronStub__ = { app: new EventEmitter(), webContents: { getAllWebContents: () => contents, fromId: id => contents.find(c => c.id === id) } }
writeFileSync(join(directory, 'bridge.mjs'), stubbed + '\nexport { handle, claims };\n')
const { handle, claims, start, stop } = await import(pathToFileURL(join(directory, 'bridge.mjs')))
const guest = id => ({ id, getType: () => 'webview', getURL: () => `https://page${id}.example/`, getTitle: () => 'identical title', isDestroyed: () => closed.includes(id), debugger: { isAttached: () => true, sendCommand: async () => ({}) } })
const shell = { id: 1, getType: () => 'window', getURL: () => 'dsh-app://app/', getTitle: () => 'DSH', isDestroyed: () => false,
  executeJavaScript: async expression => {
    if (expression.includes('api.panelGuests')) return JSON.stringify(expression.includes('session-a') ? [2, 3] : [4])
    if (expression.includes('api.closePanelGuest')) { const id = expression.includes(', 3)') ? 3 : 2; closed.push(id); return JSON.stringify({ ok: true, closed: 1 }) }
    return 'none'
  },
}

test('non-object JSON frames cannot escape the pre-auth callback', () => {
  writeFileSync(join(directory, 'child.mjs'), `
    import { connect } from 'node:net'; import { EventEmitter } from 'node:events';
    globalThis.__electronStub__={app:new EventEmitter(),webContents:{getAllWebContents:()=>[]}};
    process.env.DSH_HOME=${JSON.stringify(directory)};
    const {start,stop}=await import('./bridge.mjs'); const server=start();
    server.once('listening',()=>{const socket=connect({host:'127.0.0.1',port:server.address().port},()=>socket.write(process.argv[2]+'\\n'));socket.resume();socket.on('error',()=>{});socket.on('close',()=>{stop();process.exit(0)});});
    setTimeout(()=>process.exit(2),2000);
  `)
  for (const frame of ['null', '[]', '42', '"text"', 'true']) {
    const child = spawnSync(process.execPath, [join(directory, 'child.mjs'), frame], { encoding: 'utf8', timeout: 4000 })
    assert.equal(child.status, 0, `${frame}: ${child.stderr}`)
  }
})

test('an unauthenticated oversized frame is disconnected', async () => {
  process.env.DSH_HOME = directory
  contents.length = 0
  const server = start()
  await once(server, 'listening')
  const socket = connect({ host: '127.0.0.1', port: server.address().port })
  socket.on('error', () => {})
  await once(socket, 'connect')
  const disconnected = new Promise(resolve => socket.once('close', () => resolve(true)))
  socket.write('x'.repeat(70 * 1024))
  const result = await Promise.race([disconnected, new Promise(resolve => setTimeout(() => resolve(false), 250))])
  socket.destroy()
  stop()
  assert.equal(result, true, 'the pre-auth frame must be bounded')
})

test('authentication and a larger first command may arrive in the same TCP chunk', async () => {
  process.env.DSH_HOME = directory
  contents.length = 0
  const server = start()
  await once(server, 'listening')
  const endpoint = JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8'))
  const socket = connect({ host: '127.0.0.1', port: server.address().port })
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write(JSON.stringify({ token: endpoint.token }) + '\n' + JSON.stringify({ op: 'version', padding: 'x'.repeat(100_000) }) + '\n')
  let watchdog
  try {
    const [line] = await Promise.race([response, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('the first command was not answered')), 1500) })])
    assert.equal(JSON.parse(line).ok, true)
  } finally {
    clearTimeout(watchdog)
    socket.destroy()
    stop()
  }
})

test('list claims only the requested panel guests, including that panel popups', async () => {
  claims.clear(); closed.length = 0
  contents.splice(0, contents.length, shell, guest(2), guest(3), guest(4))
  const answer = await handle({ op: 'list', owner: 'session-a' })
  assert.deepEqual(answer.sidebar.map(g => g.id), [2, 3])
  assert.equal(claims.get(3), 'session-a')
  assert.equal(claims.has(4), false)
})

test('closePage uses guest identity within its panel even for duplicate titles', async () => {
  claims.clear(); closed.length = 0
  contents.splice(0, contents.length, shell, guest(2), guest(3), guest(4))
  const answer = await handle({ op: 'closePage', id: 3, owner: 'session-a' })
  assert.equal(answer.closed, 1)
  assert.deepEqual(closed, [3])
  await assert.rejects(handle({ op: 'closePage', id: 4, owner: 'session-a' }), /belong|panel/)
})

test('a missing client identity API is refused rather than exposing every unclaimed guest', async () => {
  const evaluate = shell.executeJavaScript
  contents.splice(0, contents.length, shell, guest(2), guest(4))
  shell.executeJavaScript = async () => { throw new Error('identity API unavailable; refresh or upgrade the browser plugin client') }
  try {
    await assert.rejects(handle({ op: 'list', owner: 'session-a' }), /refresh or upgrade/)
    await assert.rejects(handle({ op: 'closePage', id: 4, owner: 'session-a' }), /refresh or upgrade/)
  } finally { shell.executeJavaScript = evaluate }
})

test('an unauthenticated idle connection expires within its authentication deadline', async () => {
  process.env.DSH_HOME = directory
  contents.length = 0
  const server = start()
  await once(server, 'listening')
  const socket = connect({ host: '127.0.0.1', port: server.address().port })
  socket.on('error', () => {})
  await once(socket, 'connect')
  const began = Date.now()
  let watchdog
  try {
    await Promise.race([
      once(socket, 'close'),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('authentication deadline did not close the socket')), 6500) }),
    ])
    assert.ok(Date.now() - began < 6000)
  } finally {
    clearTimeout(watchdog)
    socket.destroy()
    stop()
  }
})
