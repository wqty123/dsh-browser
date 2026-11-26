/**
 * Real-browser E2E harness for dsh_browser_code: the production tool surface (tool-browser apply)
 * over BrowserRuntime + ElectronBrowserProvider + a headless SystemBrowserViewHost on the Chromium
 * named by DSH_TEST_CHROME, plus a local HTTP site whose pages are the fixtures.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntime } from '../../lib/browser/runtime.js'
import { registerCarrierTakeover } from '../../lib/browser/takeover-target.js'
import { ElectronBrowserProvider } from '../../lib/browser-electron/provider.js'
import { DEFAULT_SETTINGS } from '../../lib/browser-electron/settings-store.js'
import { SystemBrowserViewHost } from '../../lib/browser-electron/system-browser.js'
import { apply } from '../../lib/tool-browser/index.js'

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
const escape = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const ITEMS = Array.from({ length: 12 }, (_, i) => `Item ${String(i + 1).padStart(2, '0')}`)
const PAGE_SIZE = 5

const FORM = page('Complex form', `
<form id="signup" method="post" action="/form">
  <fieldset><legend>Account</legend>
    <label for="full">Full name</label><input id="full" name="full" required>
    <label>Email <input type="email" name="email" required></label>
    <input name="phone" placeholder="Phone number">
  </fieldset>
  <fieldset><legend>Address</legend>
    <label for="country">Country</label>
    <select id="country" name="country"><option value="">Choose…</option><option value="cn">China</option><option value="jp">Japan</option></select>
    <label for="region">Region</label><select id="region" name="region" disabled><option value="">Pick a country first</option></select>
  </fieldset>
  <fieldset><legend>Plan</legend>
    <label><input type="radio" name="plan" value="free" checked> Free</label>
    <label><input type="radio" name="plan" value="pro"> Pro</label>
  </fieldset>
  <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
  <div id="controlled-wrap"><label for="nick">Nickname</label><input id="nick"><input type="hidden" name="nick" id="nick-mirror"></div>
  <label><input type="checkbox" name="terms" value="yes"> I accept the terms</label>
  <p id="error" role="alert" hidden></p>
  <button type="submit">Create account</button>
</form>
<script>
  const regions = { cn: ['Beijing', 'Shanghai'], jp: ['Tokyo', 'Osaka'] }
  country.addEventListener('change', () => {
    region.disabled = true
    setTimeout(() => {
      region.innerHTML = (regions[country.value] || []).map(r => '<option>' + r + '</option>').join('')
      region.disabled = false
    }, 150)
  })
  // A controlled input: only the input event reaches the submitted mirror.
  nick.addEventListener('input', () => { document.getElementById('nick-mirror').value = nick.value.trim().toUpperCase() })
  signup.addEventListener('submit', event => {
    if (!signup.terms.checked) { event.preventDefault(); error.hidden = false; error.textContent = 'You must accept the terms' }
  })
</script>`)

const LONG_ORDER_FORM = page('Order form', `
<form id="order" method="post" action="/long-form">
  <p><label>Customer name: <input name="custname"></label></p>
  <p><label>Telephone: <input type="tel" name="custtel"></label></p>
  <p><label>E-mail address: <input type="email" name="custemail"></label></p>
  <fieldset><legend>Pizza Size</legend>
    <p><label><input type="radio" name="size" value="small"> Small</label></p>
    <p><label><input type="radio" name="size" value="medium"> Medium</label></p>
    <p><label><input type="radio" name="size" value="large"> Large</label></p>
  </fieldset>
  <fieldset><legend>Pizza Toppings</legend>
    <p><label><input type="checkbox" name="topping" value="bacon"> Bacon</label></p>
    <p><label><input type="checkbox" name="topping" value="cheese"> Extra Cheese</label></p>
  </fieldset>
  <div style="height: 1600px" aria-hidden="true"></div>
  <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
  <p><button type="submit">Submit order</button></p>
</form>`)

const SHADOW = page('Shadow DOM', `
<app-shell><p slot="note">Slotted light-DOM note</p></app-shell>
<closed-widget></closed-widget>
<p id="status">idle</p>
<script>
  customElements.define('login-card', class extends HTMLElement {
    constructor() {
      super()
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = '<label for="user">Shadow user</label><input id="user" placeholder="Shadow username"><button id="go">Continue in shadow</button>'
      root.getElementById('go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'shadow user: ' + root.getElementById('user').value
      })
    }
  })
  customElements.define('app-shell', class extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = '<h2>Outer shadow heading</h2><slot name="note"></slot><login-card></login-card>'
    }
  })
  customElements.define('closed-widget', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed shadow secret</button>' }
  })
</script>`)

const CANVAS = page('Canvas', `
<canvas id="board" width="400" height="200" style="display:block;margin:40px;border:1px solid #333"></canvas>
<script>
  const hits = []
  const ctx = board.getContext('2d')
  const draw = label => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 200)
    ctx.fillStyle = '#1565c0'; ctx.fillRect(260, 70, 120, 60)
    ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('Buy', 300, 108)
    ctx.fillStyle = '#000'; ctx.fillText(label, 20, 108)
  }
  draw('Ready')
  board.addEventListener('click', event => {
    const x = event.offsetX, y = event.offsetY
    const inside = x >= 260 && x <= 380 && y >= 70 && y <= 130
    hits.push({ x, y, inside, trusted: event.isTrusted })
    if (inside) draw('Bought')
  })
  window.canvasHits = () => hits
</script>`)

function multipart(body, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? '')
  if (!boundary) return []
  const marker = Buffer.from('--' + (boundary[1] ?? boundary[2]))
  const parts = []
  let start = body.indexOf(marker)
  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length)
    if (next < 0) break
    const part = body.subarray(start + marker.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString()
    parts.push({ name: /name="([^"]*)"/.exec(head)?.[1], filename: /filename="([^"]*)"/.exec(head)?.[1], data: part.subarray(split + 4) })
    start = next
  }
  return parts
}

/**
 * Start the fixture site. `state` records what the server observed (form posts, uploads, OAuth
 * exchanges, hanging requests) so a test can assert on effects, not only on what the page shows.
 */
export async function fixtureSite(t) {
  const state = { forms: [], uploads: [], oauth: { approved: false, tokens: [] }, hanging: new Set() }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const html = (text, status = 200, headers = {}) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); response.end(text) }
    const cookie = Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map(part => part.trim().split('=')))
    switch (url.pathname) {
      case '/form':
        if (request.method === 'POST') {
          const fields = Object.fromEntries(new URLSearchParams(body.toString()))
          state.forms.push(fields)
          return html(page('Account created', `<h1>Account created</h1><pre id="echo">${escape(JSON.stringify(fields))}</pre>`))
        }
        return html(FORM)
      case '/long-form':
        if (request.method === 'POST') {
          const fields = Object.fromEntries(new URLSearchParams(body.toString()))
          state.forms.push(fields)
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          return response.end(JSON.stringify({ form: fields }))
        }
        return html(LONG_ORDER_FORM)
      case '/items': {
        const n = Math.max(1, Number(url.searchParams.get('page') ?? 1))
        const pages = Math.ceil(ITEMS.length / PAGE_SIZE)
        const rows = ITEMS.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE).map(item => `<li class="item">${item}</li>`).join('')
        const prev = n > 1 ? `<a href="/items?page=${n - 1}" rel="prev">‹ Previous</a>` : ''
        const next = n < pages ? `<a href="/items?page=${n + 1}" rel="next">Next ›</a>` : ''
        return html(page(`Items page ${n} of ${pages}`, `<h1>Items</h1><ul>${rows}</ul><nav>${prev} <span>Page ${n} of ${pages}</span> ${next}</nav>`))
      }
      case '/feed':
        return html(page('Feed', `<ul id="feed"></ul><button id="more">Load more</button><script>
          let offset = 0
          const more = async () => {
            more.busy = true
            const rows = await (await fetch('/api/items?offset=' + offset)).json()
            await new Promise(r => setTimeout(r, 120))
            for (const row of rows) { const li = document.createElement('li'); li.className = 'item'; li.textContent = row; feed.append(li) }
            offset += rows.length
            if (offset >= ${ITEMS.length}) document.getElementById('more').remove()
            more.busy = false
          }
          document.getElementById('more').addEventListener('click', () => { if (!more.busy) more() })
          more()
        </script>`))
      case '/api/items': {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(JSON.stringify(ITEMS.slice(offset, offset + 4)))
      }
      case '/upload':
        if (request.method === 'POST') {
          const files = multipart(body, request.headers['content-type']).filter(part => part.filename !== undefined && part.filename !== '')
          for (const file of files) state.uploads.push({ field: file.name, filename: file.filename, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') })
          return html(page('Upload received', `<h1>Upload received</h1><ul>${files.map(file => `<li class="file">${escape(file.filename)} (${file.data.length} bytes)</li>`).join('')}</ul>`))
        }
        return html(page('Upload', `<form method="post" action="/upload" enctype="multipart/form-data">
          <label for="file">Attachment</label><input type="file" id="file" name="attachment">
          <p id="picked">nothing picked</p><button type="submit">Upload</button></form>
          <script>file.addEventListener('change', () => { picked.textContent = 'picked: ' + [...file.files].map(f => f.name + ':' + f.size).join(',') })</script>`))
      case '/app':
        if (cookie.session && state.oauth.tokens.includes(cookie.session)) return html(page('Dashboard', '<h1>Signed in as alice</h1><p id="who">alice@example.test</p>'))
        return html(page('Example app', `<h1>Example app</h1><a href="/authorize?client_id=app&redirect_uri=${encodeURIComponent('/callback')}&state=xyz">Sign in with Example ID</a>`))
      case '/authorize':
        // A provider page only a person can complete: password plus a human check the agent must not solve.
        return html(page('Example ID sign-in', `<h1>Sign in to Example ID</h1>
          <form id="login" onsubmit="return false"><label>Password <input type="password" name="password"></label>
          <div class="g-recaptcha" data-sitekey="fixture"><label><input type="checkbox" id="robot"> I'm not a robot</label></div>
          <button>Sign in</button></form><p id="hint">Waiting for you to finish signing in…</p>
          <script>setInterval(async () => {
            const { approved } = await (await fetch('/authorize/status')).json()
            if (approved) location.href = '/callback?code=fixture-code&state=' + new URLSearchParams(location.search).get('state')
          }, 150)</script>`))
      case '/authorize/status':
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ approved: state.oauth.approved }))
      case '/callback': {
        if (url.searchParams.get('code') !== 'fixture-code' || url.searchParams.get('state') !== 'xyz') return html(page('OAuth error', '<h1>Bad callback</h1>'), 400)
        const token = 'tok-' + (state.oauth.tokens.length + 1)
        state.oauth.tokens.push(token)
        response.writeHead(302, { location: '/app', 'set-cookie': `session=${token}; Path=/; HttpOnly` })
        return response.end()
      }
      case '/shadow': return html(SHADOW)
      case '/canvas': return html(CANVAS)
      case '/hang':
        // Never answers: the request stays open until the browser gives up on it.
        state.hanging.add(response)
        response.on('close', () => state.hanging.delete(response))
        return
      case '/slow-script':
        return html(page('Slow', '<h1>Slow page</h1><button id="spin" onclick="const end = Date.now() + 1500; while (Date.now() < end);">Busy work</button>'))
      default:
        return html(page('Not found', '<h1>Not found</h1>'), 404)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(done => { for (const response of state.hanging) response.destroy(); server.closeAllConnections?.(); server.close(() => done()) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, state, url: path => origin + path }
}

/**
 * DSH_TEST_CHROME, which must be the browser binary itself: the host only stops a browser whose
 * running executable is the one it launched, so a wrapper script that execs Chrome is never cleaned up.
 */
function chromeBinary() {
  const path = realpathSync(process.env.DSH_TEST_CHROME)
  if (readFileSync(path).subarray(0, 2).toString() === '#!') throw new Error(`DSH_TEST_CHROME=${path} is a script; point it at the Chrome binary it runs`)
  return path
}

/** Wait until no process holds the profile, so removing it cannot race the browser's own shutdown. */
async function profileReleased(profile) {
  if (process.platform !== 'linux') return
  for (let i = 0; i < 100; i++) {
    const holders = readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`--user-data-dir=${profile}`) } catch { return false }
    })
    if (holders.length === 0) return
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`browser still holds ${profile} after dispose`)
}

/**
 * The production code tool over a real headless Chromium. `approval` stands in for DSH's approval
 * service (the native card the human answers), so a takeover is driven exactly as in the product.
 */
export async function codeBrowser(t, { approval } = {}) {
  const previousHome = process.env.DSH_HOME
  const previousSurface = globalThis.__dshBrowserSurface
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-p1-')))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  mkdirSync(workspace); mkdirSync(profile)
  process.env.DSH_HOME = join(root, 'home')
  // Loopback fixture pages are refused on the Web panel surface; the standalone browser is the product path here.
  globalThis.__dshBrowserSurface = 'builtin'
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: chromeBinary() }, profile, [], profile, undefined, 'headless', undefined, undefined, { managed: true })
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false }, settings: () => DEFAULT_SETTINGS })
  const ctx = new Context()
  const runtime = new BrowserRuntime(ctx)
  runtime.registerBrowserProvider(provider)
  const unregisterTakeover = registerCarrierTakeover(runtime, owner => provider.takeoverTargets(owner).map(target => ({ ...target, connected: () => true })))
  const tools = new Map()
  const disposers = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  apply({
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section() {} },
    effect: fn => { disposers.push(fn()) },
    get: name => name === 'browser' ? runtime : name === 'approval' ? approval : undefined,
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    attachments: { saveImage: async () => ({ attachmentId: 'image-1', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }) },
  }, {})
  const agent = { id: `p1-${Math.random().toString(36).slice(2)}`, session: { header: { cwd: workspace } }, model: { current: () => ({ provider: 'test', model: 'vision' }) } }
  let call = 0
  const run = (code, { timeoutMs, signal = new AbortController().signal } = {}) => tools.get('dsh_browser_code').execute(
    { code, ...timeoutMs === undefined ? {} : { timeoutMs } }, { signal, agent, callId: `cell-${++call}` })
  t.after(async () => {
    for (const dispose of disposers) dispose?.()
    unregisterTakeover()
    provider.dispose()
    host.dispose()
    await ctx.fiber?.dispose?.()
    await profileReleased(profile)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousSurface === undefined) delete globalThis.__dshBrowserSurface
    else globalThis.__dshBrowserSurface = previousSurface
    rmSync(root, { recursive: true, force: true })
  })
  return { run, tools, workspace, root, provider, agent }
}
