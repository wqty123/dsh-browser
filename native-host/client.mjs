import { extensionMessages } from '../assets/browser-messages.mjs'
import { AUTH_TIMEOUT_MS, CLIENT_OPERATION_TIMEOUT_MS, MAX_IN_FLIGHT, NATIVE_FILES } from '../browser-extension/constants.mjs'
import { createConnection } from 'node:net'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decoder, send, Reassembler } from './protocol.mjs'

export const proof = (secret, nonce, epoch, installId) => createHmac('sha256', secret)
  .update(`dsh-extension/v1\0${nonce}\0${epoch}\0${installId}`).digest('hex')

export function readConfiguration(directory) {
  try { return JSON.parse(readFileSync(join(directory, NATIVE_FILES.config), 'utf8')) } catch { return undefined }
}

export class NativeBrowserClient {
  #socket
  #connecting
  #pending = new Map()
  #listeners = new Set()
  #epoch
  #disposed = false
  constructor(directory, browser) { this.directory = directory; this.browser = browser; this.state = 'extension-missing' }
  status() {
    const config = readConfiguration(this.directory)
    const state = config?.disabled ? 'disabled' : this.#socket && !this.#socket.destroyed && this.#epoch ? 'connected'
      : config && !config.installId ? 'not-paired' : config ? 'not-connected' : 'extension-missing'
    return { state, connected: state === 'connected', browser: this.browser,
      profile: config?.label, connectionId: config?.installId, epoch: this.#epoch,
      detail: state === 'disabled' ? 'Extension access is disabled.' : state === 'connected' ? `Connected to ${this.browser}: ${config.label} (personal profile; background tabs)`
        : state === 'not-paired' ? 'Extension is not paired. Enter the one-time install token in extension options.'
          : extensionMessages.en.notConnected }
  }
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  async connect() {
    if (this.#disposed) throw Error('extension carrier was released')
    if (this.#epoch && this.#socket && !this.#socket.destroyed) return
    this.#connecting ??= this.#connect().finally(() => { this.#connecting = undefined })
    return this.#connecting
  }
  async #connect() {
    const config = readConfiguration(this.directory)
    if (config?.disabled || !config?.installId || !/^[a-f0-9]{64}$/.test(config.secret ?? '') || config.browser !== this.browser) throw Error(this.status().detail)
    let endpoint
    try { endpoint = JSON.parse(readFileSync(join(this.directory, NATIVE_FILES.relay), 'utf8')) } catch { throw Error(this.status().detail) }
    if (typeof endpoint.endpoint !== 'string' || typeof endpoint.epoch !== 'string') throw Error('invalid extension relay descriptor')
    await new Promise((resolve, reject) => {
      const socket = createConnection(endpoint.endpoint)
      this.#socket = socket
      const timer = setTimeout(() => { reject(Error('extension authentication timed out')); socket.destroy() }, AUTH_TIMEOUT_MS)
      const fail = error => { clearTimeout(timer); reject(error); socket.destroy() }
      const chunks = new Reassembler()
      let authenticatedServer = false
      const frames = decoder(part => {
        const message = chunks.accept(part)
        if (!message) return
        if (message.type === 'challenge') {
          if (this.#epoch || message.epoch !== endpoint.epoch || !/^[a-f0-9]{64}$/.test(message.nonce ?? '')) return fail(Error('invalid extension challenge'))
          const expected = proof(config.secret, message.nonce, message.epoch, `${config.installId}:server`)
          if (!/^[a-f0-9]{64}$/.test(message.proof ?? '') || !timingSafeEqual(Buffer.from(expected), Buffer.from(message.proof))) return fail(Error('extension relay authentication refused'))
          authenticatedServer = true
          send(socket, { type: 'auth', proof: proof(config.secret, message.nonce, message.epoch, config.installId) })
        } else if (!this.#epoch) {
          if (!authenticatedServer || message.type !== 'ready' || message.epoch !== endpoint.epoch || message.installId !== config.installId
            || message.browser !== this.browser) return fail(Error('extension authentication refused'))
          this.#epoch = message.epoch; clearTimeout(timer); resolve()
        } else if (message.type === 'event') {
          for (const listener of this.#listeners) listener(message)
        } else if (message.type === 'result') {
          const pending = this.#pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer); this.#pending.delete(message.id)
          message.error ? pending.reject(Error(message.error)) : pending.resolve(message.value)
        } else fail(Error('unexpected extension message'))
      }, fail)
      socket.on('data', chunk => frames.push(chunk))
      socket.on('error', fail)
      socket.on('close', () => {
        clearTimeout(timer); reject(Error('extension disconnected'))
        if (this.#socket !== socket) return
        this.#socket = undefined; this.#epoch = undefined
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('extension disconnected; operation was not replayed')) }
        this.#pending.clear()
        for (const listener of this.#listeners) listener({ type: 'event', method: 'transport.disconnected' })
      })
    })
  }
  async request(operation) {
    await this.connect()
    if (this.#pending.size >= MAX_IN_FLIGHT) throw Error('extension request limit reached')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(Error('extension operation timed out; it was not replayed')); this.#socket?.destroy() }, CLIENT_OPERATION_TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
      try { send(this.#socket, { type: 'request', id, operation }) }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error) }
    })
  }
  dispose() { this.#disposed = true; this.#socket?.destroy() }
}
