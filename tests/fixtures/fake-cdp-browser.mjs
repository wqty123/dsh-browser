// A browser that can be killed and restarted, so recovery is actually exercised.
//
// The reporter's point: a stub that exits at once can only assert that a command fails. It
// never gets as far as the state that mattered — a browser replaced while views still hold
// session ids from the dead one — so it could not have caught H1-H3 even if it had run. This
// is a minimal CDP server: it speaks enough of the protocol to hand out a target and a
// session, it can be killed, and it can come back on a new port, which is what the carrier
// has to cope with.
//
// Sessions belong to the CONNECTION that created them, as they do in CDP: a page attached
// over one WebSocket is not addressable from another. Modelling that is what makes a stale
// session id detectable after a dropped connection instead of accidentally still valid.
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

/** The subset of CDP this plugin needs: create a target, attach to it. */
/**
 * @param options - knobs for the behaviours a test needs to observe.
 * @param options.browserName - what `/json/version` reports as `Browser`. The default deliberately
 *   does NOT look like Chrome: adoption requires the endpoint to name a real browser, so a fake
 *   that claimed to be one would be adopted by every test that only wanted a launch. Tests about
 *   adoption pass a Chrome-like name explicitly.
 * @param options.blanks - target ids that exist as blank pages BEFORE this client connects, which
 *   is the state a real Chrome is in (it opens more than one page on start).
 * @param options.failAttaches - number of initial attach commands refused, for creation recovery.
 */
function createFakeBrowser(options = {}) {
  const browserName = options.browserName ?? 'Fake/1.0'
  /** Pages that exist before the client connects; never created by a command. */
  const preexisting = [...(options.blanks ?? [])]
  /** Pages created through `Target.createTarget`. */
  const created = []
  /** Target ids closed through `Target.closeTarget`. */
  const closed = []
  /** Target ids attached through `Target.attachToTarget`, oldest first. */
  const attached = []
  /** Whether discovery was turned on before the first listing. */
  let discoveryEnabled = false
  let listedBeforeDiscovery = 0
  /** The last session id handed out, for a test to observe. */
  let lastSessionId = ''
  /** Debugging connections accepted so far: a drop plus a reconnect is two. */
  let connections = 0
  let attachFailuresLeft = options.failAttaches ?? 0

  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        Browser: browserName,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser`,
      }))
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
    // This connection's own CDP state: a page attached here is addressable here and nowhere
    // else, so an id issued before a drop is rejected afterwards rather than quietly reused.
    connections += 1
    const state = { targetId: '', sessionId: '', sessions: new Set() }
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
        const reply = handleCommand(message, state)
        if (reply !== undefined) socket.write(encodeFrame(JSON.stringify(reply)))
      }
    })
  })

  /** Answer the commands the carrier sends, on the live target. */
  function handleCommand(message, state) {
    if (message.id === undefined) return undefined
    if (message.method === 'Target.setDiscoverTargets') {
      discoveryEnabled = true
      return { id: message.id, result: {} }
    }
    if (message.method === 'Target.getTargets') {
      // A listing before discovery is a listing a real browser may not complete: pages that
      // existed before the client connected can be missing from it. That is the failure the
      // first attempt at this fix hit silently, so the fake reproduces it.
      if (!discoveryEnabled) listedBeforeDiscovery += 1
      const ids = discoveryEnabled ? [...preexisting, ...created] : [...created]
      return {
        id: message.id,
        result: { targetInfos: ids.map(targetId => ({ targetId, type: 'page', url: 'about:blank' })) },
      }
    }
    if (message.method === 'Target.closeTarget') {
      closed.push(message.params?.targetId)
      return { id: message.id, result: { success: true } }
    }
    if (message.method === 'Browser.getVersion') {
      // The protocol half of adoption's evidence. A bare-looking product is refused there, so
      // this mirrors the HTTP half rather than answering something the real browser would not.
      return { id: message.id, result: { product: browserName } }
    }
    if (message.method === 'Target.createTarget') {
      state.targetId = `target-${randomUUID()}`
      created.push(state.targetId)
      return { id: message.id, result: { targetId: state.targetId } }
    }
    if (message.method === 'Target.attachToTarget') {
      attached.push(message.params?.targetId)
      if (attachFailuresLeft > 0) {
        attachFailuresLeft -= 1
        return { id: message.id, error: { message: 'attach refused by test browser' } }
      }
      state.sessionId = `session-${randomUUID()}`
      state.sessions.add(state.sessionId)
      lastSessionId = state.sessionId
      return { id: message.id, result: { sessionId: state.sessionId } }
    }
    // Every page command goes to an attached session; a stale one is a protocol error,
    // which is exactly the failure H3 produced.
    if (message.sessionId !== undefined && !state.sessions.has(message.sessionId)) {
      return { id: message.id, sessionId: message.sessionId, error: { message: 'Session with given id not found.' } }
    }
    return { id: message.id, sessionId: message.sessionId, result: {} }
  }

  return {
    get port() { return server.address().port },
    get sessionId() { return lastSessionId },
    get connections() { return connections },
    /** Target ids closed through the protocol, so a test can see what was tidied away. */
    get closed() { return [...closed] },
    /** Target ids attached, so a test can see WHICH page a view ended up on. */
    get attached() { return [...attached] },
    /** Pages created by the client, which adoption is supposed to avoid needing. */
    get created() { return [...created] },
    /** How many list attempts arrived before discovery was enabled (should be none). */
    get listedBeforeDiscovery() { return listedBeforeDiscovery },
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    /**
     * Drop every live debugging connection while the process stays up.
     *
     * This is the failure the exit listener cannot see, and therefore the one that reaches
     * `start()`'s own cleanup: a browser that closed its debugging endpoint, or a socket the
     * OS tore down. Nothing has cleared the view and session maps by the time it happens.
     */
    dropConnections() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
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
