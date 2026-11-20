/**
 * End-to-end proof of the reference pipeline, driven entirely from the host side.
 *
 * The sidebar's own picture cannot be automated reliably (it lives in a browser we cannot click), but
 * the pipeline behind it is: a session is created over HTTP, a real text selection is made in the
 * engine over CDP, the bar's confirm button is pressed, and the question "did the capture land under
 * the right conversation, and was it queued for delivery" is answered from the files and routes.
 *
 * Usage: node verify-reference.cjs <token>
 */
const fs = require('node:fs')
const path = require('node:path')

const TOKEN = process.argv[2]
const PORT = 3099
const PROBE = 'D:\\dsh-probe-home'
const SESSION_ID = 'verify-1'

/** Cookie jar for the host's authenticated routes. */
let cookie = ''

async function login() {
  const response = await fetch(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, { redirect: 'manual' })
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? '']
  cookie = raw.map(entry => entry.split(';')[0]).filter(Boolean).join('; ')
  if (cookie === '') throw new Error('no auth cookie issued')
}

/** Call one plugin route as the panel would. */
async function plugin(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/dsh-builtin-browser${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin: `http://127.0.0.1:${PORT}`,
      referer: `http://127.0.0.1:${PORT}/`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  return { status: response.status, body: parsed }
}

/** Minimal CDP client over the engine's debugger socket. */
class Cdp {
  constructor(url) {
    this.next = 0
    this.pending = new Map()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('cdp socket error')))
    })
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  send(method, params, sessionId) {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 20000).unref?.()
    })
  }
}

/** Run one expression in the page and return its value. */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails.text)}`)
  return result.result.value
}

/** Wait for a predicate on the page, polling. */
async function until(label, check, timeoutMs = 20000) {
  const started = Date.now()
  for (;;) {
    if (await check()) return true
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Drag across a text run with real pointer events, the way a reader selects. */
async function dragSelect(cdp, sessionId, box) {
  const y = Math.round(box.top + box.height / 2)
  const from = { x: Math.round(box.left + 2), y, button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from }, sessionId)
  const steps = 8
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((box.left + box.width - 4 - from.x) * step) / steps)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sessionId)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.left + box.width - 4), y, button: 'left', clickCount: 1 }, sessionId)
}

async function main() {
  console.log('1. login')
  await login()

  console.log(`2. create a session labelled "${SESSION_ID}"`)
  const live = await plugin('/panel/live', { session: SESSION_ID, url: 'https://cn.bing.com/search?q=shudu' })
  console.log('   ', JSON.stringify(live.body))
  const engine = live.body.engine
  if (typeof engine !== 'string' || engine === '') throw new Error('no engine returned')

  console.log('3. attach to that page in the engine')
  const portFile = path.join(PROBE, 'dsh-builtin-browser-host', 'edge-profile', 'DevToolsActivePort')
  await until('the engine to expose CDP', () => fs.existsSync(portFile), 40000)
  const [debugPort] = fs.readFileSync(portFile, 'utf8').trim().split('\n')
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.ready
  const targets = await cdp.send('Target.getTargets')
  const page = targets.targetInfos.filter(t => t.type === 'page').find(t => t.url.includes('shudu'))
  if (page === undefined) throw new Error('the page for this session is not in the engine')
  const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const sessionId = attached.sessionId

  console.log('4. wait for the page to render')
  await until('the page to finish loading', async () => (await evaluate(cdp, sessionId, 'document.readyState')) === 'complete', 30000)
  // The bar is installed by the host's pump, one tick every 1.2 s, and a tick that lands before the
  // page settles is simply repeated — so this waits for it instead of sampling once.
  const overlayReady = await until('the overlay to be installed', async () => {
    return (await evaluate(cdp, sessionId, 'window.__dshRefOverlayInstalled === true')) === true
  }, 20000).then(() => true).catch(() => false)
  console.log('   overlay installed:', overlayReady)
  if (overlayReady !== true) throw new Error('the reference overlay is not in the page')

  console.log('5. select a run of real text with the pointer')
  const box = await evaluate(cdp, sessionId, `(() => {
    const nodes = [...document.querySelectorAll('h2, p, li, span')]
      .filter(node => (node.innerText || '').trim().length > 12 && node.getBoundingClientRect().width > 120 && node.getBoundingClientRect().top > 60)
    const node = nodes[0]
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, text: node.innerText.slice(0, 40) }
  })()`)
  if (box === null) throw new Error('no selectable text found')
  console.log('   selecting:', JSON.stringify(box.text))
  await dragSelect(cdp, sessionId, box)
  await new Promise(resolve => setTimeout(resolve, 400))
  const selected = await evaluate(cdp, sessionId, 'String(window.getSelection().toString()).slice(0, 60)')
  console.log('   selection:', JSON.stringify(selected))
  if (selected === '') throw new Error('the drag produced no selection')

  console.log('6. the bar must appear')
  const barShown = await until('the bar to appear', async () => {
    const state = await evaluate(cdp, sessionId, `(() => {
      const host = document.getElementById('__dsh-ref-overlay')
      if (!host) return 'absent'
      return getComputedStyle(host).display === 'none' ? 'hidden' : 'shown'
    })()`)
    return state === 'shown'
  }).then(() => true).catch(() => false)
  console.log('   bar shown:', barShown)

  console.log('7. press confirm')
  const pressed = await evaluate(cdp, sessionId, `(() => {
    const button = document.getElementById('__dsh-ref-overlay-add')
    if (!button) return 'no-button'
    button.click()
    return 'clicked'
  })()`)
  console.log('   confirm:', pressed)

  console.log('8. the host must collect the intent and store the reference')
  const referencesFile = path.join(PROBE, 'dsh-builtin-browser-host', 'references.jsonl')
  await until('the reference to be stored', () => fs.existsSync(referencesFile), 15000).catch(() => undefined)
  const stored = fs.existsSync(referencesFile)
    ? fs.readFileSync(referencesFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const last = stored[stored.length - 1]
  console.log('   references stored:', stored.length)
  if (last !== undefined) {
    console.log('   owner.sessionId:', JSON.stringify(last.owner && last.owner.sessionId))
    console.log('   pageUrl:', JSON.stringify((last.source && last.source.pageUrl || '').slice(0, 70)))
    console.log('   parts:', (last.parts || []).map(part => part.type).join('+'))
  }

  console.log('9. the reference must be queued for the SAME conversation')
  const mine = await plugin(`/reference/deliveries?sessionId=${encodeURIComponent(SESSION_ID)}`)
  const other = await plugin('/reference/deliveries?sessionId=some-other-conversation')
  console.log('   deliveries for this session:', JSON.stringify(mine.body).slice(0, 300))
  console.log('   deliveries for another session:', JSON.stringify(other.body).slice(0, 200))

  console.log('10. summary')
  const ownerOk = last !== undefined && last.owner && last.owner.sessionId === SESSION_ID
  const queuedOk = Array.isArray(mine.body.deliveries) && mine.body.deliveries.length > 0
  console.log('   owner is the sidebar conversation:', ownerOk)
  console.log('   queued for that conversation:', queuedOk)
  console.log(ownerOk && queuedOk ? 'RESULT: PASS' : 'RESULT: FAIL')
}

main().catch(error => {
  console.log('ERROR:', error.message)
  process.exitCode = 1
})
