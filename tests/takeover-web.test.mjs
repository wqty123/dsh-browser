import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'
import { handleGuest } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { TAKEOVER_ROUTE, TAKEOVER_TOOL } from '../src/takeover-protocol.ts'
import { takeoverHost, until } from './fixtures/takeover-host.mjs'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('real Chromium opaque Web guest: human login, sidebar completion, fresh snapshot, skip and turn stop', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const require = createRequire(import.meta.url)
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')).href)
  const bundle = await rolldown({ input: fileURLToPath(new URL('./fixtures/takeover-client.tsx', import.meta.url)), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
    plugins: [{ name: 'test-client-types-and-styles',
      async load(id) {
        if (!id.endsWith('.css')) return
        const css = await readFile(id, 'utf8')
        const names = Object.fromEntries([...css.matchAll(/\.([a-zA-Z][\w-]*)/gu)].map(match => [match[1], match[1]]))
        return { code: `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);export default ${JSON.stringify(names)}`, moduleType: 'js' }
      },
      transform(code, id) {
        if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        } }).outputText
      },
    }],
  })
  const { output } = await bundle.generate({ format: 'esm' }).finally(() => bundle.close())
  const javascript = output.find(chunk => chunk.type === 'chunk').code
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  dns.lookup = async (...args) => args[0] === 'takeover.example' ? [{ address: '93.184.216.34', family: 4 }] : originalLookup(...args)
  globalThis.fetch = async (target, options) => new URL(target).hostname === 'takeover.example'
    ? new Response(`<!doctype html><title>Login required</title><h1>Sign in</h1><label>Your name <input id="name"></label>
      <button id="login" onclick="document.title='Logged in';document.querySelector('h1').textContent='Welcome back, '+document.querySelector('#name').value;history.replaceState({},'', '/finished')">Sign in manually</button>`, { headers: { 'content-type': 'text/html' } })
    : originalFetch(target, options)
  const host = takeoverHost(), jar = new GuestCookieJar(), storage = new GuestStorage(), errors = []
  const font = process.env.DSH_TEST_FONT ? await readFile(process.env.DSH_TEST_FONT) : undefined
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><meta charset="utf-8"><style>${font ? '@font-face{font-family:TakeoverTest;src:url(/font)}' : ''}body{font:14px TakeoverTest,sans-serif;margin:0}#viewport{position:relative;height:500px}.takeover{min-height:30px;background:#eff6ff}</style><div id="toolbar"></div><div id="viewport"></div><script type="module" src="/client.js"></script>`); return }
    if (req.url === '/font' && font) { res.setHeader('content-type', 'font/otf'); res.end(font); return }
    if (req.url === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(javascript); return }
    void (req.url?.startsWith(TAKEOVER_ROUTE) ? host.routes.get(TAKEOVER_ROUTE)(req, res) : handleGuest(req, res, '', '', jar, storage))
      .catch(error => { errors.push(String(error)); res.destroy(error) })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    host.dispose(); globalThis.fetch = originalFetch; dns.lookup = originalLookup
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  const page = await chromiumPage(t)
  await page.navigate(`http://127.0.0.1:${server.address().port}/`)
  const waitBrowser = expression => page.evaluate(`new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-started>7000){clearInterval(timer);reject(new Error('browser condition timed out: '+${JSON.stringify(expression)}))}},20)})`)
  await waitBrowser('window.takeoverConnected === true')
  const tool = host.tools.get(TAKEOVER_TOOL)
  const result = tool.execute({ reason: '请登录测试网站', instructions: '请亲自完成登录，然后确认。' }, host.exec)
  await until(() => host.native.length === 1)
  await waitBrowser(`document.body.textContent.includes('AI 正在等待你完成操作：请登录测试网站')`)
  await page.evaluate('document.fonts.ready.then(() => true)')
  const screenshot = async name => {
    if (!process.env.DSH_TEST_EVIDENCE_DIR) return
    await mkdir(process.env.DSH_TEST_EVIDENCE_DIR, { recursive: true })
    const { data } = await page.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(process.env.DSH_TEST_EVIDENCE_DIR, name), Buffer.from(data, 'base64'))
  }
  assert.equal(await page.evaluate(`getComputedStyle([...document.querySelectorAll('button')].find(button=>button.textContent==='确认完成')).backgroundColor`), 'rgb(37, 99, 235)')
  await screenshot('BJ-takeover-waiting.png')
  await assert.rejects(host.tools.get('dsh_browser_open').execute({ url: 'https://takeover.example/other' }, host.exec), /awaiting human takeover/)
  const { targetInfos } = await page.command('Target.getTargets')
  const guest = targetInfos.find(target => target.type === 'iframe')
  let guestSession, executionContextId
  if (guest) guestSession = (await page.command('Target.attachToTarget', { targetId: guest.targetId, flatten: true })).sessionId
  else {
    const tree = await page.command('Page.getFrameTree')
    const frameId = tree.frameTree.childFrames[0].frame.id
    executionContextId = (await page.command('Page.createIsolatedWorld', { frameId, worldName: 'human-test' })).executionContextId
  }
  const human = await page.command('Runtime.evaluate', { ...(executionContextId ? { contextId: executionContextId } : {}),
    expression: `document.querySelector('#name').value='Human'; document.querySelector('#login').click(); document.title`, returnByValue: true }, guestSession)
  assert.equal(human.result.value, 'Logged in')
  await waitBrowser(`document.querySelector('iframe') !== null`)
  await page.evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='确认完成').click()`)
  const value = await result
  assert.equal(value.outcome, 'done')
  assert.equal(value.page.url, 'https://takeover.example/finished')
  assert.equal(value.page.title, 'Logged in')
  assert.equal(value.page.fresh, true)
  assert.match(value.page.snapshotHint, /Welcome back, Human/u)
  assert.equal(host.native[0].answerable, false)
  await waitBrowser(`!document.body.textContent.includes('AI 正在等待你完成操作')`)
  await screenshot('BJ-takeover-complete.png')
  const skipped = tool.execute({ reason: '可选操作' }, host.exec)
  await waitBrowser(`document.body.textContent.includes('可选操作')`)
  await page.evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='跳过').click()`)
  assert.equal((await skipped).outcome, 'skipped')
  const stopped = tool.execute({ reason: '停止测试' }, host.exec)
  await waitBrowser(`document.body.textContent.includes('停止测试')`)
  host.controller.abort()
  assert.equal((await stopped).outcome, 'cancelled')
  await waitBrowser(`!document.body.textContent.includes('AI 正在等待你完成操作')`)
  assert.equal(host.native.every(card => !card.answerable), true)
  assert.deepEqual(errors, [])
  console.log('Chromium takeover: manual login → done + fresh URL/title/text; skip; stop; losing card and banner withdrawn')
})
