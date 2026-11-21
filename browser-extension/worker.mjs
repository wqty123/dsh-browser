import { ExtensionController } from './controller.mjs'

const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome'
const MAX_MESSAGE = 8 * 1024 * 1024, CHUNK = 48 * 1024
let port, connecting, pairing, inFlight = 0, reconnectAllowed = true
let status = { state: 'extension-missing', detail: 'Native host is disconnected.' }
const controller = new ExtensionController(chrome, event => { try { port?.postMessage(event) } catch {} })

async function connect() {
  if (port) return
  connecting ??= (async () => {
    const stored = await chrome.storage.local.get('installId')
    const installId = stored.installId ?? crypto.randomUUID()
    if (!stored.installId) await chrome.storage.local.set({ installId })
    const native = chrome.runtime.connectNative(`com.dsh.browser.${browser}`)
    port = native
    native.onMessage.addListener(message => {
      if (native !== port) return
      if (message.type === 'status') status = { state: message.state, detail: message.detail }
      else if (message.type === 'paired' && pairing?.id === message.id) {
        clearTimeout(pairing.timer); pairing.resolve(message); pairing = undefined
      } else if (message.type === 'release') void controller.release()
      else if (message.type === 'request') {
        if (inFlight >= 32) { native.postMessage({ type: 'result', id: message.id, error: 'extension concurrency limit' }); return }
        inFlight++
        void controller.request(message.operation).then(
          value => respond(native, { type: 'result', id: message.id, value }),
          error => respond(native, { type: 'result', id: message.id, error: String(error.message ?? error).slice(0, 1024) }),
        ).catch(() => native.disconnect()).finally(() => { inFlight-- })
      }
    })
    native.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      if (native !== port) return
      port = undefined
      status = { state: 'extension-missing', detail: 'Native host disconnected or is not installed. Reconnect after installing.' }
      if (pairing) { clearTimeout(pairing.timer); pairing.resolve({ ok: false, error: status.detail }); pairing = undefined }
      void controller.release()
      if (reconnectAllowed) void chrome.alarms.create('native-reconnect', { delayInMinutes: 1 })
    })
    native.postMessage({ type: 'hello', installId, browser })
  })().finally(() => { connecting = undefined })
  return connecting
}

function respond(native, value) {
  if (native !== port) return
  let text = JSON.stringify(value)
  if (new TextEncoder().encode(text).length > MAX_MESSAGE) text = JSON.stringify({ type: 'result', id: value.id, error: 'extension response exceeds 8 MiB limit' })
  const total = Math.ceil(text.length / CHUNK)
  for (let index = 0; index < total; index++) native.postMessage({ type: 'chunk', id: value.id, index, total, data: text.slice(index * CHUNK, (index + 1) * CHUNK) })
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false
  void (async () => {
    if (message.type === 'status') return { ...status, browser, extensionId: chrome.runtime.id }
    if (message.type === 'disconnect') {
      reconnectAllowed = false; await chrome.storage.local.set({ paused: true }); await chrome.alarms.clear('native-reconnect')
      port?.disconnect(); return { ok: true }
    }
    if (message.type === 'connect') {
      reconnectAllowed = true; await chrome.storage.local.set({ paused: false }); await connect(); return { ok: true }
    }
    if (message.type === 'pair') {
      if (pairing || typeof message.token !== 'string' || message.token.length > 128) throw Error('pairing request is invalid or busy')
      reconnectAllowed = true; await chrome.storage.local.set({ paused: false }); await connect()
      return new Promise(resolve => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => { pairing = undefined; resolve({ ok: false, error: 'Pairing timed out. Check native-host installation.' }) }, 10000)
        pairing = { id, timer, resolve }; port.postMessage({ type: 'pair', id, token: message.token })
      })
    }
    throw Error('unsupported options request')
  })().then(reply, error => reply({ ok: false, error: String(error.message ?? error) }))
  return true
})
chrome.debugger.onDetach.addListener((_source, reason) => {
  if (reason === 'canceled_by_user') {
    reconnectAllowed = false
    void chrome.storage.local.set({ paused: true })
    void chrome.alarms.clear('native-reconnect')
    port?.disconnect()
  }
})
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'native-reconnect' && reconnectAllowed) void connect().catch(() => {}) })
void chrome.storage.local.get('paused').then(({ paused }) => { reconnectAllowed = !paused; if (reconnectAllowed) return connect() }).catch(() => {})
