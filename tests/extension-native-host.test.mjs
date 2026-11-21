import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { encode, decoder, MAX_FRAME, MAX_MESSAGE, chunkMessage, Reassembler, send } from '../native-host/protocol.mjs'
import { serve, pair, saveConfiguration } from '../native-host/host.mjs'
import { NativeBrowserClient, proof } from '../native-host/client.mjs'
import { registration } from '../native-host/install.mjs'

const extensionId = 'a'.repeat(32)
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ext-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  const config = { browser: 'edge', extensionId, secret: 'b'.repeat(64), label: 'Controlled test profile', pairDigest: createHash('sha256').update('one-time-test').digest('hex'), pairExpires: Date.now() + 10000 }
  saveConfiguration(path, config)
  return { directory, path, config }
}

test('bounded native framing supports fragmentation/coalescing and fails closed on invalid data', () => {
  const values = [], errors = [], frames = decoder(value => values.push(value), error => errors.push(error))
  const data = Buffer.concat([encode({ a: '你好' }), encode({ b: 2 })])
  for (const byte of data) frames.push(Buffer.from([byte]))
  frames.end()
  assert.deepEqual(values, [{ a: '你好' }, { b: 2 }]); assert.equal(errors.length, 0)
  for (const size of [0, MAX_FRAME + 1, 0xffffffff]) {
    const errors = [], frames = decoder(() => assert.fail(), error => errors.push(error)), header = Buffer.alloc(4)
    header.writeUInt32LE(size); frames.push(header); frames.push(Buffer.alloc(100)); assert.equal(errors.length, 1)
  }
  for (const body of [Buffer.from('[]'), Buffer.from('{broken}'), Buffer.from([0xff])]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length)
    let error; decoder(() => assert.fail(), value => { error = value }).push(Buffer.concat([header, body])); assert.ok(error)
  }
  let truncated; const partial = decoder(() => assert.fail(), error => { truncated = error }); partial.push(Buffer.from([1])); partial.end(); assert.match(truncated.message, /truncated/)
})

test('chunking bounds aggregate size and rejects duplicate, reordered and invalid chunks', () => {
  const message = { type: 'result', id: 'test', value: '你好'.repeat(100000) }
  const parts = chunkMessage(message), chunks = new Reassembler()
  let result
  for (const part of parts) { assert.ok(encode(part).length <= MAX_FRAME + 4); result = chunks.accept(part) }
  assert.deepEqual(result, message)
  assert.throws(() => new Reassembler().accept(parts[1]), /unexpected/)
  const duplicate = new Reassembler(); duplicate.accept(parts[0]); assert.throws(() => duplicate.accept(parts[0]), /order/)
  assert.throws(() => chunkMessage({ id: 'oversize', value: 'x'.repeat(MAX_MESSAGE) }), /limit/)
  assert.throws(() => new Reassembler().accept({ type: 'chunk', id: 'x', index: 0, total: 257, data: '' }), /invalid/)
})

test('pairing is one-time, expiring, profile-bound and exact-origin allowlisted', async t => {
  const { path, config } = fixture(t), installId = randomUUID()
  assert.throws(() => pair(path, 'wrong', installId), /invalid/)
  assert.equal(pair(path, 'one-time-test', installId).installId, installId)
  assert.throws(() => pair(path, 'one-time-test', randomUUID()), /used/)
  saveConfiguration(path, { ...config, pairExpires: Date.now() - 1 })
  assert.throws(() => pair(path, 'one-time-test', installId), /expired/)
  for (const origin of [undefined, 'https://example.test/', `chrome-extension://${'c'.repeat(32)}/`, `chrome-extension://${extensionId}/suffix`]) {
    await assert.rejects(serve({ input: new PassThrough(), output: new PassThrough(), configPath: path, origin }), /origin/)
  }
})

test('authenticated native relay carries chunked debugger responses, refuses unauthenticated/replayed proof and revokes', async t => {
  const { directory, path } = fixture(t), installId = randomUUID()
  pair(path, 'one-time-test', installId)
  const input = new PassThrough(), output = new PassThrough(), statuses = []
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve })
  output.on('data', (() => { const frames = decoder(message => {
    if (message.type === 'status') { statuses.push(message); if (message.state === 'connected') readyResolve() }
    if (message.type === 'request') {
      const value = { echo: message.operation, image: 'x'.repeat(600000) }
      for (const part of chunkMessage({ type: 'result', id: message.id, value })) send(input, part)
    }
  }, error => assert.fail(error.message)); return value => frames.push(value) })())
  const host = await serve({ input, output, configPath: path, origin: `chrome-extension://${extensionId}/` })
  t.after(() => host.stop())
  send(input, { type: 'hello', installId, browser: 'edge' }); await ready
  const descriptor = JSON.parse(readFileSync(join(directory, 'relay.json'), 'utf8'))
  async function invalid(authenticate) {
    const socket = createConnection(descriptor.endpoint), challenge = await new Promise(resolve => {
      socket.once('data', data => decoder(resolve, error => assert.fail(error.message)).push(data))
    })
    const closed = once(socket, 'close')
    send(socket, authenticate(challenge)); await closed
    return challenge
  }
  const challenge = await invalid(() => ({ type: 'request', id: 'not-authenticated', operation: { kind: 'close', tabId: 1 } }))
  const oldProof = proof('b'.repeat(64), challenge.nonce, challenge.epoch, installId)
  await invalid(() => ({ type: 'auth', proof: oldProof }))
  const client = new NativeBrowserClient(directory, 'edge'); t.after(() => client.dispose())
  assert.equal(client.status().state, 'extension-missing')
  const result = await client.request({ kind: 'cdp', scope: 's', method: 'Page.captureScreenshot' })
  assert.equal(result.image.length, 600000); assert.equal(client.status().state, 'connected')
  assert.equal(client.status().profile, 'Controlled test profile')
  const disconnected = new Promise(resolve => client.onEvent(event => { if (event.method === 'transport.disconnected') resolve() }))
  const current = JSON.parse(readFileSync(path, 'utf8')); saveConfiguration(path, { ...current, secret: 'c'.repeat(64), installId: undefined })
  await disconnected
  assert.equal(client.status().state, 'not-paired')
})

test('runtime transport status does not claim readiness for missing, unpaired or wrong browser config', async t => {
  const { path, directory } = fixture(t)
  const client = new NativeBrowserClient(directory, 'edge'); t.after(() => client.dispose())
  assert.equal(client.status().state, 'not-paired')
  await assert.rejects(client.request({ kind: 'list', scope: 's' }), /not paired/)
  pair(path, 'one-time-test', randomUUID())
  const wrong = new NativeBrowserClient(directory, 'chrome'); t.after(() => wrong.dispose())
  await assert.rejects(wrong.connect(), /missing|disconnected/)
  const absent = new NativeBrowserClient(join(directory, 'absent'), 'edge'); t.after(() => absent.dispose())
  assert.equal(absent.status().connected, false)
})

test('native registration is per-user and browser-specific on Windows, macOS and Linux', () => {
  assert.equal(registration('edge', 'manifest', { platform: 'win32' }).registry, 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.dsh.browser.edge')
  assert.equal(registration('chrome', 'manifest', { platform: 'win32' }).registry, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dsh.browser.chrome')
  assert.equal(registration('edge', 'manifest', { platform: 'darwin', home: '/user' }).file, '/user/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.dsh.browser.edge.json')
  assert.equal(registration('chrome', 'manifest', { platform: 'darwin', home: '/user' }).file, '/user/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.browser.chrome.json')
  assert.equal(registration('chrome', 'manifest', { platform: 'linux', home: '/user', xdg: '/xdg' }).file, '/xdg/google-chrome/NativeMessagingHosts/com.dsh.browser.chrome.json')
  assert.equal(registration('edge', 'manifest', { platform: 'linux', home: '/user', xdg: '' }).file, '/user/.config/microsoft-edge/NativeMessagingHosts/com.dsh.browser.edge.json')
  assert.throws(() => registration('edge', 'manifest', { platform: 'unknown' }), /unsupported/)
})
