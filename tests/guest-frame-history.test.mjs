import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { handleGuest } from '../src/browser-electron/guest-route.ts'
import { guestRuntimeScript } from '../src/browser-electron/guest-runtime.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { GuestFrameHistory } from '../src/client/browser/frame-history.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('GuestFrameHistory re-enables Back and clears Forward after Back followed by a branched navigation', () => {
  const h = new GuestFrameHistory()
  h.reset(5)
  // Initial document at joint depth 5
  h.record({ depth: 5, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 1)
  assert.equal(h.canGoForward(), false)
  assert.equal(h.step(-1), false)

  // Navigate 1 -> 2 (joint depth 6)
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 2)
  assert.equal(h.canGoForward(), false)

  // Back 2 -> 1 (joint depth stays 6 because entry 2 sits on the forward stack)
  assert.equal(h.step(-1), true)
  assert.equal(h.depth(), 1)
  assert.equal(h.canGoForward(), true)
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'back_forward' })
  assert.equal(h.depth(), 1, 'back_forward confirmation must not inflate Back depth')
  assert.equal(h.canGoForward(), true)

  // Branch 1 -> 3: forward stack is truncated and entry 3 is pushed, so joint depth is still 6
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 2, 'branched navigation must re-enable Back even when joint depth is unchanged')
  assert.equal(h.canGoForward(), false, 'branched navigation truncates the stale forward entry')
  assert.equal(h.step(1), false, 'cannot step past the truncated forward boundary')

  // Back 3 -> 1 works and stops at 1 without stepping into host history
  assert.equal(h.step(-1), true)
  assert.equal(h.depth(), 1)
  assert.equal(h.step(-1), false)
})

test('GuestFrameHistory handles deep back-and-branch where joint history shrinks, plus multi-step forward', () => {
  const h = new GuestFrameHistory()
  h.reset(5)
  h.record({ depth: 5, reason: 'sync', navigationType: 'navigate' })
  // 1 -> 2 -> 3 (joint depth 7)
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'navigate' })
  h.noteDocumentChange()
  h.record({ depth: 7, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 3)

  // Back twice to 1
  assert.equal(h.step(-1), true)
  h.noteDocumentChange()
  h.record({ depth: 7, reason: 'sync', navigationType: 'back_forward' })
  assert.equal(h.step(-1), true)
  h.noteDocumentChange()
  h.record({ depth: 7, reason: 'sync', navigationType: 'back_forward' })
  assert.equal(h.depth(), 1)
  assert.equal(h.canGoForward(), true)

  // Forward once to 2, still able to forward to 3
  assert.equal(h.step(1), true)
  h.noteDocumentChange()
  h.record({ depth: 7, reason: 'sync', navigationType: 'back_forward' })
  assert.equal(h.depth(), 2)
  assert.equal(h.canGoForward(), true)

  // Back to 1 again, then branch to 4: joint history shrinks from 7 to 6
  assert.equal(h.step(-1), true)
  h.noteDocumentChange()
  h.record({ depth: 7, reason: 'sync', navigationType: 'back_forward' })
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 2)
  assert.equal(h.canGoForward(), false)
})

test('GuestFrameHistory handles same-document pushState branch, replace, reload, and initial location.replace', () => {
  const h = new GuestFrameHistory()
  h.reset(5)
  h.record({ depth: 5, reason: 'sync', navigationType: 'navigate' })

  // location.replace() at tip keeps depth === baseDepth: must not fabricate a Back entry
  h.noteDocumentChange()
  h.record({ depth: 5, reason: 'sync', navigationType: 'navigate' })
  assert.equal(h.depth(), 1)

  // SPA pushState -> Back (popstate) -> pushState branch at unchanged depth 6
  h.record({ depth: 6, reason: 'push', navigationType: 'navigate' })
  assert.equal(h.depth(), 2)
  assert.equal(h.step(-1), true)
  h.record({ depth: 6, reason: 'pop', navigationType: 'navigate' })
  assert.equal(h.depth(), 1)
  assert.equal(h.canGoForward(), true)
  h.record({ depth: 6, reason: 'replace', navigationType: 'navigate' })
  assert.equal(h.depth(), 1, 'replaceState must not advance Back depth')
  h.noteDocumentChange()
  h.record({ depth: 6, reason: 'sync', navigationType: 'reload' })
  assert.equal(h.depth(), 1, 'reload must not advance Back depth')
  assert.equal(h.canGoForward(), true, 'reload must preserve forward stack')
  h.record({ depth: 6, reason: 'push', navigationType: 'navigate' })
  assert.equal(h.depth(), 2, 'branched pushState must re-enable Back')
  assert.equal(h.canGoForward(), false, 'branched pushState must clear Forward')
})

test('guestRuntimeScript compiles cleanly and reports history reason and navigationType', () => {
  const code = guestRuntimeScript('https://history.example/one')
  assert.doesNotThrow(() => new vm.Script(code))
  assert.match(code, /navigationType/)
  assert.match(code, /report\('pop'\)/)
  assert.match(code, /report\('pageshow'\)/)
  assert.match(code, /report\('sync'\)/)
  assert.match(code, /report\('ready'\)/)
})

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
  let pushOnLoad = false
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  dns.lookup = async (...args) => args[0] === 'history.example' ? [{ address: '93.184.216.34', family: 4 }] : originalLookup(...args)
  globalThis.fetch = async (target, options) => {
    if (new URL(target).hostname !== 'history.example') return originalFetch(target, options)
    const method = options?.method ?? 'GET'
    requests.push(method)
    return new Response(method === 'POST' ? '<!doctype html><title>Posted</title><p>posted</p>'
      : `<!doctype html><title>One</title><form method="post" action="/one"><input name="q" value="1"></form>
        ${pushOnLoad ? `<script>history.pushState({}, '', location.href)</script>` : ''}<script>addEventListener('message', event => { if (event.data === 'submit') document.forms[0].submit() })</script>`, { headers: { 'content-type': 'text/html' } })
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
  const canGoForward = () => page.evaluate('framePage.frame.getSnapshot().canGoForward')
  await until(() => page.evaluate(`framePage.frame.getSnapshot().address === 'observed' && !framePage.frame.getSnapshot().loading`), 'the guest did not load')
  assert.equal(await page.evaluate('history.length'), 5)
  assert.equal(await canGoBack(), false)
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage('submit', '*')`)
  await until(() => requests.at(-1) === 'POST', 'the guest form was not posted')
  await until(canGoBack, 'the posted document did not report its frame history entry')
  await page.evaluate('framePage.frame.goBack()')
  await until(() => requests.lastIndexOf('GET') > requests.indexOf('POST'), 'Back did not return the guest to its first document')
  await until(async () => !await canGoBack(), 'Back stayed available at the first guest document')
  assert.equal(await canGoForward(), true)
  assert.equal(await page.evaluate('location.pathname'), '/host/c')
  // Submit again after going Back: joint history length stays 6, yet Back must be enabled and Forward cleared.
  const postsBeforeBranch = requests.filter(m => m === 'POST').length
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage('submit', '*')`)
  await until(() => requests.filter(m => m === 'POST').length > postsBeforeBranch, 'the branched guest form was not posted')
  await until(canGoBack, 'Back remained disabled after a branched navigation following Back')
  assert.equal(await canGoForward(), false)
  await page.evaluate('framePage.frame.goBack()')
  await until(async () => !await canGoBack(), 'Back did not return to the first document after branching')
  assert.equal(await page.evaluate('location.pathname'), '/host/c')
  pushOnLoad = true
  await page.navigate(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(`new Promise(resolve => { const poll = () => window.startFrame ? resolve(startFrame()) : setTimeout(poll, 10); poll() })`)
  await until(canGoBack, 'a same-URL entry the guest pushed while starting was not offered to Back')
  await page.evaluate('framePage.frame.goBack()')
  await until(async () => !await canGoBack(), 'Back did not return to the entry before the startup push')
  assert.equal(await page.evaluate('location.pathname'), '/host/c')
})
