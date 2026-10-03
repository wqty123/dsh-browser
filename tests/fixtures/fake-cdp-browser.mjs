// A browser that can be killed and restarted, so recovery is actually exercised.
//
// The reporter's point: a stub that exits at once can only assert that a command fails. It
// never gets as far as the state that mattered — a browser replaced while views still hold
// session ids from the dead one — so it could not have caught H1-H3 even if it had run. This
// is a minimal CDP server: it speaks enough of the protocol to hand out a target and a
// session, it can be killed, and it can come back on a new port, which is what the carrier
// has to cope with.
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

/** The subset of CDP this plugin needs: create a target, attach to it. */
function createFakeBrowser() {
  /** One page, with an id and a session id that change with every launch. */
  let targetId = ''
  let sessionId = ''

  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ Browser: 'Fake/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser` }))
      return
    }
    response.writeHead(404)
    response.end()
  })

  const sockets = new Set()
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    // Minimal WebSocket handshake: RFC 6455's fixed GUID.
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // Frames can be split across chunks, so accumulate until a whole one is present:
    // decoding chunk by chunk truncated the JSON and looked like a protocol failure.
    let buffered = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const { frames, rest } = decodeFrames(buffered)
      buffered = rest
      for (const frame of frames) {
        let message
        try {
          message = JSON.parse(frame)
        } catch {
          continue
        }
        const reply = handleCommand(message)
        if (reply !== undefined) socket.write(encodeFrame(JSON.stringify(reply)))
      }
    })
  })

  /** Answer the two commands the carrier sends, on the live target. */
  function handleCommand(message) {
    if (message.id === undefined) return undefined
    if (message.method === 'Target.createTarget') {
      targetId = `target-${randomUUID()}`
      return { id: message.id, result: { targetId } }
    }
    if (message.method === 'Target.attachToTarget') {
      sessionId = `session-${randomUUID()}`
      return { id: message.id, result: { sessionId } }
    }
    // Every page command goes to the current session; a stale one is a protocol error,
    // which is exactly the failure H3 produced.
    if (message.sessionId !== undefined && message.sessionId !== sessionId) {
      return { id: message.id, sessionId: message.sessionId, error: { message: 'Session with given id not found.' } }
    }
    return { id: message.id, sessionId: message.sessionId, result: {} }
  }

  return {
    get port() { return server.address().port },
    get targetId() { return targetId },
    get sessionId() { return sessionId },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    /** Kill it the way a closed window ends: sockets drop, the port stops answering. */
    async kill() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Decode as many whole client frames as the buffer holds, returning the remainder. */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  for (;;) {
    if (offset + 2 > buffer.length) break
    const length = buffer[offset + 1] & 0x7f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let start = offset + 2
    let payloadLength = length
    if (length === 126) {
      if (start + 2 > buffer.length) break
      payloadLength = buffer.readUInt16BE(start)
      start += 2
    } else if (length === 127) {
      if (start + 8 > buffer.length) break
      payloadLength = Number(buffer.readBigUInt64BE(start))
      start += 8
    }
    const mask = masked ? buffer.subarray(start, start + 4) : undefined
    if (masked) start += 4
    if (start + payloadLength > buffer.length) break
    const payload = buffer.subarray(start, start + payloadLength)
    if (mask !== undefined) {
      const unmasked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4]
      frames.push(unmasked.toString('utf8'))
    } else {
      frames.push(payload.toString('utf8'))
    }
    offset = start + payloadLength
  }
  return { frames, rest: buffer.subarray(offset) }
}

/** Encode one unmasked text frame (the server side is not required to mask). */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

export { createFakeBrowser }
