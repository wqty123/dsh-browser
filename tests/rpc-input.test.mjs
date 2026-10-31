import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'

import { createRpcLineReader } from '../lib/browser-electron/rpc-input.js'

async function connection(t, onError) {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const accepted = new Promise(resolve => server.once('connection', resolve))
  const socket = createConnection({ host: '127.0.0.1', port: server.address().port })
  const reader = createRpcLineReader(socket, onError)
  // events.once(socket, 'close') would reject at the expected error event,
  // instead of observing the close that must still drive host shutdown.
  const closed = new Promise(resolve => socket.once('close', resolve))
  const peer = await accepted
  peer.on('error', () => {})
  t.after(() => {
    reader.close()
    socket.destroy()
    peer.destroy()
    server.close()
  })
  return { socket, reader, peer, closed }
}

test('a graceful parent disconnect delivers its last line and closes without errors', { timeout: 5000 }, async t => {
  const errors = []
  const { reader, peer, closed } = await connection(t, error => errors.push(error))
  const lines = []
  reader.on('line', line => lines.push(line))
  peer.end('last message\n')
  await closed
  assert.deepEqual(lines, ['last message'])
  assert.deepEqual(errors, [])
})

test('a real parent reset is reported once without an uncaught readline error', { timeout: 5000 }, async t => {
  const errors = []
  const { peer, closed } = await connection(t, error => errors.push(error))
  // Unlike destroy(), resetAndDestroy() deterministically sends TCP RST.
  // Without the readline error listener this test raises uncaughtException,
  // which can also prevent the socket's own error listener from running.
  peer.resetAndDestroy()
  await closed
  assert.equal(errors.length, 1, 'the transport fault is recorded once')
  assert.equal(errors[0].code, 'ECONNRESET')
})

test('transport failures remain observable after the line reader is closed', { timeout: 5000 }, async t => {
  const errors = []
  const { reader, peer, closed } = await connection(t, error => errors.push(error))
  reader.close()
  peer.resetAndDestroy()
  await closed
  assert.equal(errors.length, 1, 'closing readline must not remove transport diagnostics')
  assert.equal(errors[0].code, 'ECONNRESET')
})
