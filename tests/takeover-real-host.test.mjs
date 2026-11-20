import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { chromiumPage } from './fixtures/chromium-page.mjs'
import { realHostPackage } from './fixtures/takeover-real-host-package.mjs'

test('real rc.5 Web server + production client: immediate tool open/takeover and request-only user-tab adoption', {
  skip: (!process.env.DSH_TEST_REAL_HOST || !process.env.DSH_TEST_CHROME) && 'set DSH_TEST_REAL_HOST to an installed rc.5 runtime and DSH_TEST_CHROME',
  timeout: 120000,
}, async t => {
  const root = join(homedir(), '.cache/dsh-builtin-browser-real-host')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'takeover-'))
  const { cli, patch } = await realHostPackage(directory, process.env.DSH_TEST_REAL_HOST)
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const host = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
    cwd: process.env.DSH_TEST_REAL_HOST, env: { ...process.env, NODE_OPTIONS: '', DSH_HOME: join(directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  const exited = once(host, 'exit')
  t.after(async () => { host.kill(); await exited; await writeFile(join(directory, 'server.log'), logs.replace(/\?token=[^\s]+/gu, '?token=REDACTED')) })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('real rc.5 startup failed: ' + logs)), 30000)
    const output = chunk => {
      logs += chunk
      const match = logs.match(/dsh web: (http[^\s]+)/u)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    host.stdout.on('data', output); host.stderr.on('data', output)
    host.once('error', reject)
  })
  const page = await chromiumPage(t)
  await page.command('Page.navigate', { url })
  const until = async (expression, message, timeout = 15000) => {
    const value = await page.evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=async()=>{try{const value=await(${expression});if(value){resolve(value);return}}catch{}if(Date.now()-start>${timeout}){reject(new Error(${JSON.stringify(message)}));return}setTimeout(check,50)};check()})`)
    return value
  }
  await until('Boolean(window.__takeoverHost && window.__dshBuiltinBrowser)', 'real plugin did not load')
  const createSession = async () => page.evaluate(`(async()=>{
    document.querySelectorAll('button').forEach(b=>{if(b.textContent==='Continue')b.click()});
    window.__takeoverHost.locale.setLocale('zh');
    window.driver=async data=>{const r=await fetch('/takeover-real-host-driver',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(JSON.stringify(value));return value};
    const value=await driver({operation:'create'});window.testSessionId=value.sessionId;window.__takeoverHost.uiWorkspace.openSession(value.sessionId);return value
  })()`)
  const call = async (name, args) => page.evaluate(`driver({operation:'call',name:${JSON.stringify(name)},args:${JSON.stringify(args)}})`)
  const result = async id => until(`driver({operation:'result',id:${JSON.stringify(id)}}).then(value=>value&&!value.pending?value:false)`, 'tool did not settle')
  const begin = async () => page.evaluate(`driver({operation:'turn'})`)
  const complete = async (callId, button = '确认完成', login = false) => {
    console.log('real-host answering:', button, login ? 'after login navigation' : 'without navigation')
    await until(`document.body.innerText.includes('请接管浏览器：人工确认') && [...document.querySelectorAll('button')].some(b=>b.textContent==='允许一次') && [...document.querySelectorAll('button')].some(b=>b.textContent==='确认完成')`, 'native card and sidebar banner did not both appear')
    const before = await page.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(directory, 'waiting.png'), Buffer.from(before.data, 'base64'))
    if (login) {
      const { targetInfos } = await page.command('Target.getTargets')
      const guest = targetInfos.find(target => target.type === 'iframe')
      let guestSession, executionContextId
      if (guest) guestSession = (await page.command('Target.attachToTarget', { targetId: guest.targetId, flatten: true })).sessionId
      else {
        const tree = await page.command('Page.getFrameTree')
        executionContextId = (await page.command('Page.createIsolatedWorld', { frameId: tree.frameTree.childFrames[0].frame.id, worldName: 'human-login-test' })).executionContextId
      }
      const human = await page.command('Runtime.evaluate', { ...(executionContextId ? { contextId: executionContextId } : {}),
        expression: `document.querySelector('#username').value='practice';document.querySelector('#password').value='SuperSecretPassword!';document.querySelector('button[type="submit"]').click();true`, returnByValue: true }, guestSession)
      assert.equal(human.exceptionDetails, undefined, JSON.stringify(human.exceptionDetails))
      await until(`[...document.querySelectorAll('input')].some(input=>input.value.includes('/secure')) || driver({operation:'result',id:${JSON.stringify(callId)}}).then(value=>value&&!value.pending?value:false)`, 'human login did not navigate to secure page', 7000)
      const early = await page.evaluate(`driver({operation:'result',id:${JSON.stringify(callId)}})`)
      if (!early.pending) assert.equal(early.value?.outcome, 'done', JSON.stringify(early))
      await until(`[...document.querySelectorAll('button')].some(b=>b.textContent==='确认完成')`, 'sidebar answer disappeared during human navigation')
    }
    await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(button)}).click()`)
    const value = await result(callId)
    console.log('real-host outcome:', button, value.value?.outcome ?? value.error)
    assert.equal(value.error, undefined)
    assert.equal(value.value.outcome, ['确认完成', '允许一次'].includes(button) ? 'done' : 'skipped')
    assert.equal(value.value.page.fresh, true)
    assert.match(value.value.page.url, login ? /^https:\/\/practice\.expandtesting\.com\/secure/u : /^https:\/\/practice\.expandtesting\.com\//u)
    assert.match(value.value.page.title, login ? /Secure/iu : /Login|Secure/iu)
    if (login) assert.match(value.value.page.snapshotHint, /Hi, practice!/u)
    await until(`![...document.querySelectorAll('button')].some(b=>b.textContent==='确认完成'||b.textContent==='允许一次')`, 'losing card/banner was not withdrawn')
    return value.value
  }
  await createSession()
  await until('document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session")===window.testSessionId', 'fresh conversation not mounted')
  await begin()
  const opened = await call('dsh_browser_open', { url: 'https://practice.expandtesting.com/login', surface: 'panel' })
  assert.equal((await result(opened.id)).value.carrier, 'panel-iframe-navigation-requested')
  const requested = await call('dsh_browser_request_takeover', { reason: '人工确认' })
  await complete(requested.id)
  for (const button of ['跳过', '允许一次', '拒绝']) {
    const next = await call('dsh_browser_request_takeover', { reason: '人工确认' })
    await complete(next.id, button)
  }
  const loginRequested = await call('dsh_browser_request_takeover', { reason: '人工确认' })
  await complete(loginRequested.id, '确认完成', true)
  await createSession()
  await until('document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session")===window.testSessionId', 'second conversation not mounted')
  await page.evaluate(`window.__dshBuiltinBrowser.openPanel(window.testSessionId,'https://practice.expandtesting.com/login')`)
  await begin()
  const userRequested = await call('dsh_browser_request_takeover', { reason: '人工确认' })
  await complete(userRequested.id)
  const unsupported = await call('dsh_browser_snapshot', {})
  assert.match((await result(unsupported.id)).error, /nothing is open in this task/u, 'adoption must not grant a task a browser/CDP session')
  console.log('real rc.5 Web: login navigation + sidebar 确认完成 → done; sidebar 跳过 → skipped; card 允许一次 → done; card 拒绝 → skipped; fresh summaries and request-only adoption')
  console.log('real-host evidence: ' + directory)
})
