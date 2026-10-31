// End-to-end: a real HTTP server behind the preview route, a real Chrome behind the capture.
//
// The unit tests prove the route's decisions. This proves the two halves join: an HTTP request that
// survives origin and switch checks reaches a passive capture of a page that is actually open, and
// what comes back is a JPEG a browser can paint.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handlePreviewFrame, PREVIEW_ROUTE } from '../lib/browser-electron/preview-route.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const raw = typeof event.data === 'string' ? event.data
      : Buffer.isBuffer(event.data) ? event.data.toString('utf8')
        : event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString('utf8') : ''
    let message
    try { message = JSON.parse(raw) } catch { return }
    if (typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } }))
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)) }, 20000).unref?.()
      })
    },
    close() { try { socket.close() } catch {} },
  }
}

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'dsh-e2e-preview-'))
const portFile = join(profile, 'DevToolsActivePort')
const child = spawn(CHROME, [
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-startup-window',
], { stdio: 'ignore' })

let cdpPort = null
for (let i = 0; i < 300 && cdpPort === null; i++) {
  if (existsSync(portFile)) {
    const n = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim())
    if (Number.isInteger(n) && n > 0) cdpPort = n
  }
  if (cdpPort === null) await sleep(10)
}
if (cdpPort === null) { console.log('  no CDP endpoint'); child.kill(); process.exit(1) }

const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
const client = await connect(version.webSocketDebuggerUrl)
console.log(`  ${version.Browser}`)

// A page with something visible on it, then attach ONCE (the route captures repeatedly).
const { targetId } = await client.send('Target.createTarget', {
  url: 'data:text/html,<body style="background:%23246"><h1 style="color:%23fff;font:48px sans-serif">live</h1></body>',
  background: true,
})
await sleep(700)
const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
await client.send('Page.enable', {}, sessionId)

/** Stands in for the provider: same CDP call the real carrier makes, without presentation. */
const browser = {
  exists: id => id === 'browser:e2e',
  async capturePassive() {
    const shot = await client.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false,
    }, sessionId)
    const base64 = shot?.data ?? ''
    if (base64 === '') throw new Error('empty')
    return { dataUrl: `data:image/jpeg;base64,${base64}` }
  },
}

const settingsOn = { get: () => ({ remoteView: { enabled: true } }) }
const settingsOff = { get: () => ({ remoteView: { enabled: false } }) }

let currentSettings = settingsOn
const server = createServer((req, res) => {
  if (!req.url?.startsWith(PREVIEW_ROUTE)) { res.writeHead(404).end(); return }
  void handlePreviewFrame(req, res, currentSettings, browser)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const headers = { origin: base, referer: `${base}/` }
console.log(`  preview server on ${base}`)

const fetchFrame = async (session, extra = {}) =>
  fetch(`${base}${PREVIEW_ROUTE}?session=${encodeURIComponent(session)}`, { headers: { ...headers, ...extra } })

// 1. sharing off -> refused, and the body names no session
currentSettings = settingsOff
const offRes = await fetchFrame('browser:e2e')
const offBody = await offRes.text()
console.log(`  sharing off      : ${offRes.status} ${offBody}`)

// 2. sharing on, valid session -> a real JPEG
currentSettings = settingsOn
const t0 = Date.now()
const okRes = await fetchFrame('browser:e2e')
const bytes = Buffer.from(await okRes.arrayBuffer())
const ms = Date.now() - t0
console.log(`  sharing on       : ${okRes.status} ${okRes.headers.get('content-type')} ${bytes.length} bytes in ${ms} ms`)
console.log(`  jpeg magic       : ${bytes.subarray(0, 2).toString('hex')} ${bytes.subarray(0, 2).toString('hex') === 'ffd8' ? '(JPEG)' : '(NOT JPEG)'}`)
console.log(`  cache-control    : ${okRes.headers.get('cache-control')}`)

// 3. three more frames, to show repeated capture works and stays JPEG
let allJpeg = true
let total = 0
for (let i = 0; i < 3; i++) {
  const r = await fetchFrame('browser:e2e')
  const b = Buffer.from(await r.arrayBuffer())
  total += b.length
  if (b.subarray(0, 2).toString('hex') !== 'ffd8') allJpeg = false
  await sleep(500)
}
console.log(`  three more frames: ${allJpeg ? 'all JPEG' : 'NOT all JPEG'}, avg ${Math.round(total / 3)} bytes`)

// 4. an unknown session -> 404, even with sharing on
const badRes = await fetchFrame('view:whatever')
console.log(`  unknown session  : ${badRes.status} ${await badRes.text()}`)

console.log('')
console.log(`  ok                : ${offRes.status === 403 && okRes.status === 200 && allJpeg && badRes.status === 404}`)

server.close()
client.close()
try { child.kill() } catch {}
await sleep(600)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
