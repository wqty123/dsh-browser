import { nativeHostName, MAX_MESSAGE, CHUNK_BYTES, MAX_IN_FLIGHT, MAX_ERROR_LENGTH, RECONNECT_ALARM, RECONNECT_DELAY_MINUTES } from './constants.mjs'
import { ExtensionController } from './controller.mjs'
import { en } from './locales.mjs'

const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome'
let port, connecting, inFlight = 0, reconnectAllowed = true
let status = { state: 'extension-missing', detail: en.disconnected }
const controller = new ExtensionController(chrome, event => { try { port?.postMessage(event) } catch {} })

async function connect() {
  if (port) return
  connecting ??= (async () => {
    const stored = await chrome.storage.local.get('installId')
    const installId = stored.installId ?? crypto.randomUUID()
    if (!stored.installId) await chrome.storage.local.set({ installId })
    const native = chrome.runtime.connectNative(nativeHostName(browser))
    port = native
    native.onMessage.addListener(message => {
      if (native !== port) return
      if (message.type === 'status') status = { state: message.state, detail: message.detail }
      else if (message.type === 'release') void controller.release()
      else if (message.type === 'request') {
        if (inFlight >= MAX_IN_FLIGHT) { native.postMessage({ type: 'result', id: message.id, error: 'extension concurrency limit' }); return }
        inFlight++
        void controller.request(message.operation).then(
          value => respond(native, { type: 'result', id: message.id, value }),
          error => respond(native, { type: 'result', id: message.id, error: String(error.message ?? error).slice(0, MAX_ERROR_LENGTH) }),
        ).catch(() => native.disconnect()).finally(() => { inFlight-- })
      }
    })
    native.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (native !== port) return
      port = undefined
      status = { state: 'extension-missing', detail: en.reconnect }
      void controller.release()
      if (reconnectAllowed) void chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_DELAY_MINUTES })
    })
    native.postMessage({ type: 'hello', installId, browser })
  })().finally(() => { connecting = undefined })
  return connecting
}

function respond(native, value) {
  if (native !== port) return
  let text = JSON.stringify(value)
  if (new TextEncoder().encode(text).length > MAX_MESSAGE) text = JSON.stringify({ type: 'result', id: value.id, error: 'extension response exceeds 8 MiB limit' })
  const total = Math.ceil(text.length / CHUNK_BYTES)
  for (let index = 0; index < total; index++) native.postMessage({ type: 'chunk', id: value.id, index, total, data: text.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES) })
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false
  void (async () => {
    if (message.type === 'status') return { ...status, browser, extensionId: chrome.runtime.id }
    if (message.type === 'disconnect') {
      reconnectAllowed = false; await chrome.storage.local.set({ paused: true }); await chrome.alarms.clear(RECONNECT_ALARM)
      port?.disconnect(); return { ok: true }
    }
    throw Error('unsupported options request')
  })().then(reply, error => reply({ ok: false, error: String(error.message ?? error) }))
  return true
})
chrome.debugger.onDetach.addListener((_source, reason) => {
  if (reason === 'canceled_by_user') {
    reconnectAllowed = false
    void chrome.storage.local.set({ paused: true })
    void chrome.alarms.clear(RECONNECT_ALARM)
    port?.disconnect()
  }
})
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === RECONNECT_ALARM && reconnectAllowed) void connect().catch(() => {}) })
const autoConnect = () => chrome.storage.local.get('paused').then(({ paused }) => { reconnectAllowed = !paused; if (reconnectAllowed) return connect() }).catch(() => {})
chrome.runtime.onInstalled.addListener(() => { void autoConnect() })
chrome.runtime.onStartup.addListener(() => { void autoConnect() })
void autoConnect()
