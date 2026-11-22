import { MAX_FRAME, MAX_MESSAGE, CHUNK_BYTES, MAX_ID_LENGTH, MAX_CHUNKS, MAX_IN_FLIGHT } from '../browser-extension/constants.mjs'
export { MAX_FRAME, MAX_MESSAGE, CHUNK_BYTES }

export function encode(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (!body.length || body.length > MAX_FRAME) throw Error('native frame exceeds limit')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

export function decoder(onMessage, onError) {
  let buffer = Buffer.alloc(0), failed = false
  return {
    push(chunk) {
      if (failed) return
      try {
        for (let offset = 0; offset < chunk.length;) {
          const need = buffer.length < 4 ? 4 - buffer.length : 4 + buffer.readUInt32LE(0) - buffer.length
          const end = Math.min(offset + need, chunk.length)
          buffer = Buffer.concat([buffer, chunk.subarray(offset, end)])
          offset = end
          if (buffer.length < 4) continue
          const size = buffer.readUInt32LE(0)
          if (!size || size > MAX_FRAME) throw Error('invalid native frame length')
          if (buffer.length !== size + 4) continue
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(4))
          buffer = Buffer.alloc(0)
          const value = JSON.parse(text)
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid native message')
          onMessage(value)
        }
      } catch (error) { failed = true; buffer = Buffer.alloc(0); onError(error) }
    },
    end() { if (!failed && buffer.length) { failed = true; onError(Error('truncated native frame')) } },
  }
}

export function send(stream, value) {
  if (stream.destroyed || stream.writableLength > MAX_MESSAGE) throw Error('native transport backpressure limit')
  stream.write(encode(value))
}

export function chunkMessage(value) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > MAX_MESSAGE) throw Error('native response exceeds limit')
  const parts = []
  for (let offset = 0; offset < text.length; offset += CHUNK_BYTES) parts.push(text.slice(offset, offset + CHUNK_BYTES))
  return parts.map((data, index) => ({ type: 'chunk', id: value.id, index, total: parts.length, data }))
}

export class Reassembler {
  #pending = new Map()
  accept(message) {
    if (message.type !== 'chunk') return message
    const { id, index, total, data } = message
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS
      || !Number.isInteger(index) || index < 0 || index >= total || typeof data !== 'string' || data.length > CHUNK_BYTES) throw Error('invalid native chunk')
    let state = this.#pending.get(id)
    if (!state) {
      if (index !== 0 || this.#pending.size >= MAX_IN_FLIGHT) throw Error('unexpected native chunk')
      state = { total, parts: [], bytes: 0 }; this.#pending.set(id, state)
    }
    if (state.total !== total || index !== state.parts.length) throw Error('out-of-order native chunk')
    state.bytes += Buffer.byteLength(data)
    if (state.bytes > MAX_MESSAGE) throw Error('native response exceeds limit')
    state.parts.push(data)
    if (state.parts.length < total) return undefined
    this.#pending.delete(id)
    const result = JSON.parse(state.parts.join(''))
    if (!result || result.id !== id || result.type === 'chunk') throw Error('invalid reassembled message')
    return result
  }
  forget(id) { this.#pending.delete(id) }
}
