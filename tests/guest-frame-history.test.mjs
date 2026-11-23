import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { handleGuest } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('Web guest Back follows only the guest frame history, not the session history the sidebar page already has', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const require = createRequire(import.meta.url)
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')).href)
  const bundle = await rolldown({ input: fileURLToPath(new URL('./fixtures/frame-history-client.ts', import.meta.url)), platform: 'browser',
    plugins: [{ name: 'test-client-styles', async load(id) {
      if (!id.endsWith('.css')) return
      const names = Object.fromEntries([...(await readFile(id, 'utf8')).matchAll(/\.([a-zA-Z][\w-]*)/gu)].map(match => [match[1], match[1]]))
      return { code: `export default ${JSON.stringify(names)}`, moduleType: 'js' }
    } }],
  })
  const { output } = await bundle.generate({ format: 'esm' }).finally(() => bundle.close())
  const javascript = output.find(chunk => chunk.type === 'chunk').code
  const requests = []
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  dns.lookup = async (...args) => args[0] === 'history.example' ? [{ address: '93.184.216.34', family: 4 }] : originalLookup(...args)
  globalThis.fetch = async (target, options) => {
    if (new URL(target).hostname !== 'history.example') return originalFetch(target, options)
    const method = options?.method ?? 'GET'
    requests.push(method)
    return new Response(method === 'POST' ? '<!doctype html><title>Posted</title><p>posted</p>'
      : `<!doctype html><title>One</title><form method="post" action="/one"><input name="q" value="1"></form>
        <script>addEventListener('message', event => { if (event.data === 'submit') document.forms[0].submit() })</script>`, { headers: { 'content-type': 'text/html' } })
  }
  const jar = new GuestCookieJar(), storage = new GuestStorage()
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><div id="viewport" style="position:relative;height:400px"></div><script type="module" src="/client.js"></script>'); return }
    if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(javascript); return }
    void handleGuest(req, res, '', '', jar, storage).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    globalThis.fetch = originalFetch; dns.lookup = originalLookup
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  const page = await chromiumPage(t)
  await page.navigate(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(`new Promise(resolve => { const poll = () => window.startFrame ? resolve(startFrame()) : setTimeout(poll, 10); poll() })`)
  const until = async (condition, message) => {
    for (const started = Date.now(); Date.now() - started < 10000; await new Promise(resolve => setTimeout(resolve, 20))) if (await condition()) return
    assert.fail(message)
  }
  const canGoBack = () => page.evaluate('framePage.frame.getSnapshot().canGoBack')
  await until(() => page.evaluate(`framePage.frame.getSnapshot().address === 'observed' && !framePage.frame.getSnapshot().loading`), 'the guest did not load')
  assert.equal(await page.evaluate('history.length'), 5)
  assert.equal(await canGoBack(), false)
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage('submit', '*')`)
  await until(() => requests.at(-1) === 'POST', 'the guest form was not posted')
  await until(canGoBack, 'the posted document did not report its frame history entry')
  await page.evaluate('framePage.frame.goBack()')
  await until(() => requests.lastIndexOf('GET') > requests.indexOf('POST'), 'Back did not return the guest to its first document')
  await until(async () => !await canGoBack(), 'Back stayed available at the first guest document')
  assert.equal(await page.evaluate('location.pathname'), '/host/c')
})
