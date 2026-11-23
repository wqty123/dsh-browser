/**
 * Anti-bot block handling end to end on a real headless Chromium: what dsh_browser_open reports for
 * each kind of bot wall, the one paced fresh-session retry a refusal gets (and nothing else gets),
 * and the automation markers a page can see. Gated on DSH_TEST_CHROME like the other real-browser suites.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { codeBrowser } from './fixtures/browser-use-e2e.mjs'

const skip = process.env.DSH_TEST_CHROME ? false : 'DSH_TEST_CHROME not set'
const RETRY_MS = 400
const doc = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

async function wallSite(t) {
  const hits = new Map()
  const agents = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname
    const seen = hits.get(path) ?? []
    seen.push(Date.now())
    hits.set(path, seen)
    agents.push(request.headers['user-agent'] ?? '')
    const send = (status, title, body) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); response.end(doc(title, body)) }
    switch (path) {
      case '/flaky':
        return seen.length === 1 ? send(403, 'Access Denied', '<h1>Access denied</h1>') : send(200, 'Catalogue', '<h1>Catalogue</h1><p>Item 42: in stock</p>')
      case '/refused': return send(403, 'Access Denied', '<h1>Access denied</h1><p>Request blocked.</p>')
      case '/captcha': return send(200, 'Security check', '<div class="g-recaptcha" style="width:304px;height:78px"><label><input type="checkbox"> I\'m not a robot</label></div>')
      case '/ip': return send(403, 'Blocked', '<p>Your IP address has been blocked. Requests from hosting providers are not allowed.</p>')
      case '/interstitial': return send(503, 'Just a moment...', '<div id="challenge-running">Checking if the site connection is secure</div>')
      case '/login': return send(200, 'Sign in', '<form><input name="email" placeholder="Email"><button>Sign in</button></form><p>This form mentions access denied in its help text.</p>')
      default: return send(404, 'Not found', '<h1>Not found</h1>')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { url: path => origin + path, hits: path => hits.get(path) ?? [], agents }
}

async function harness(t) {
  const previous = process.env.DSH_BROWSER_BLOCK_RETRY_MS
  process.env.DSH_BROWSER_BLOCK_RETRY_MS = String(RETRY_MS)
  t.after(() => { if (previous === undefined) delete process.env.DSH_BROWSER_BLOCK_RETRY_MS; else process.env.DSH_BROWSER_BLOCK_RETRY_MS = previous })
  const site = await wallSite(t)
  const browser = await codeBrowser(t)
  let call = 0
  const open = path => browser.tools.get('dsh_browser_open').execute({ url: site.url(path) }, { signal: new AbortController().signal, agent: browser.agent, callId: `open-${++call}` })
  return { site, open, ...browser }
}

test('a refusal is retried once, after a pause, in a fresh session — and the second answer is what the agent gets', { skip, timeout: 60000 }, async t => {
  const { site, open, tools, agent } = await harness(t)
  const result = await open('/flaky')
  assert.equal(result.title, 'Catalogue')
  assert.equal(result.challenge?.blocked ?? false, false)
  const hits = site.hits('/flaky')
  assert.equal(hits.length, 2)
  const tabs = await tools.get('dsh_browser_list_tabs').execute({}, { signal: new AbortController().signal, agent, callId: 'tabs-1' })
  assert.deepEqual(tabs.tabs.map(tab => new URL(tab.url).pathname), ['/flaky'], 'the refused page is not left behind')
  assert.ok(hits[1] - hits[0] >= RETRY_MS, `retry came ${hits[1] - hits[0]}ms after the refusal`)
})

test('a refusal that persists is reported with its advice and fallback routes, not retried again', { skip, timeout: 60000 }, async t => {
  const { site, open, tools } = await harness(t)
  const result = await open('/refused')
  assert.equal(site.hits('/refused').length, 2)
  assert.equal(result.challenge.blocked, true)
  assert.equal(result.challenge.recovery, 'retry')
  assert.equal(result.challenge.status, 403)
  assert.equal(result.challenge.retried, true)
  assert.deepEqual(result.challenge.fallbacks.map(route => route.kind), ['search', 'search', 'archive', 'archive'])
  const rendered = tools.get('dsh_browser_open').output.render({}, result)[0].text
  assert.match(rendered, /CHALLENGE \(access-denied, HTTP 403\).*Already retried once.*Fallback routes:/su)
})

test('a CAPTCHA goes to the human and an IP block is an environment limit: neither is retried', { skip, timeout: 60000 }, async t => {
  const { site, open } = await harness(t)
  const captcha = await open('/captcha')
  assert.equal(captcha.challenge.kind, 'recaptcha')
  assert.equal(captcha.challenge.recovery, 'takeover')
  assert.match(captcha.challenge.advice, /dsh_browser_request_takeover/u)
  assert.equal(captcha.challenge.retried, undefined)
  assert.equal(site.hits('/captcha').length, 1)
  const ip = await open('/ip')
  assert.equal(ip.challenge.kind, 'ip-block')
  assert.equal(ip.challenge.recovery, 'environment')
  assert.equal(site.hits('/ip').length, 1)
  const interstitial = await open('/interstitial')
  assert.equal(interstitial.challenge.kind, 'cloudflare')
  assert.equal(interstitial.challenge.recovery, 'wait')
  assert.equal(site.hits('/interstitial').length, 1)
})

test('an ordinary page is not a block, and dsh_browser_challenge agrees with the open', { skip, timeout: 60000 }, async t => {
  const { open, tools, agent } = await harness(t)
  const login = await open('/login')
  assert.equal(login.challenge?.blocked ?? false, false)
  const exec = { signal: new AbortController().signal, agent, callId: 'challenge-1' }
  assert.deepEqual(await tools.get('dsh_browser_challenge').execute({}, exec), { blocked: false })
  await open('/captcha')
  const checked = await tools.get('dsh_browser_challenge').execute({}, { ...exec, callId: 'challenge-2' })
  assert.equal(checked.kind, 'recaptcha')
  assert.equal(checked.recovery, 'takeover')
  assert.match(checked.advice, /dsh_browser_request_takeover/u)
  assert.ok(checked.fallbacks.length > 0)
})

test('pages see no automation markers: navigator.webdriver is off and the user agent is plain Chrome', { skip, timeout: 60000 }, async t => {
  const { site, open, run } = await harness(t)
  await open('/login')
  const seen = await run('print(await js("JSON.stringify({ webdriver: navigator.webdriver, ua: navigator.userAgent })"))')
  assert.equal(seen.ok, true, seen.output)
  const page = JSON.parse(seen.output.trim().split('\n').find(line => line.startsWith('{')))
  assert.equal(page.webdriver, false)
  assert.doesNotMatch(page.ua, /HeadlessChrome/u)
  assert.match(page.ua, /Chrome\//u)
  assert.ok(site.agents.length > 0)
  for (const agent of site.agents) assert.doesNotMatch(agent, /HeadlessChrome/u)
})
