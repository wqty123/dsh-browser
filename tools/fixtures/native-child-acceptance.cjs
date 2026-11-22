const { app, BrowserWindow, webContents } = require('electron')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('disable-gpu')
const evidence = { electron: process.versions.electron, chromium: process.versions.chrome, events: [], results: {} }
let mainWindow, maxWindows = 0, service, parent, parentLease, admission, request
const creations = [], adoptions = []
const views = new Set(), servers = [], receivedPosts = []
const log = (event, fields = {}) => { const row = { event, ...fields }; evidence.events.push(row); console.log(JSON.stringify(row)) }
app.on('browser-window-created', (_event, window) => {
  maxWindows = Math.max(maxWindows, BrowserWindow.getAllWindows().length)
  log('browser-window-created', { id: window.id, count: BrowserWindow.getAllWindows().length })
})
const html = `<!doctype html><meta charset="utf-8"><script>
window.firstOpener = !!window.opener;
window.addEventListener('message', event => {
  if (event.data?.kind === 'probe') window.opener.postMessage({ kind: 'reply', token: event.data.token, firstOpener, origin: location.origin }, '*');
});
if (window.opener) window.opener.postMessage({kind:'loaded', token:new URL(location.href).searchParams.get('case'), firstOpener, origin:location.origin}, '*');
</script><title>native child fixture</title>`

async function serve() {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', data => { body += data })
    request.on('end', () => {
      if (request.url === '/observed-posts') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(receivedPosts))
        return
      }
      if (request.method === 'POST') { receivedPosts.push({ url: request.url, method: request.method, body }); log('http-post', receivedPosts.at(-1)) }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(request.url.startsWith('/host') ? '<!doctype html><title>opener</title>' : html)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

async function run() {
  await app.whenReady()
  const origin = await serve(), cross = await serve()
  mainWindow = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
  } })
  const root = process.env.DSH_SOURCE_ROOT
  if (!root) throw new Error('Set DSH_SOURCE_ROOT to the corresponding source-built DSH checkout')
  const { DesktopNativeViews } = await import(pathToFileURL(path.join(root, 'apps/desktop/lib/types/native-views.js')))
  const { DesktopBrowserGuests } = await import(pathToFileURL(path.join(root, 'apps/desktop/lib/types/browser-guests.js')))
  await mainWindow.loadURL('data:text/html,<title>Native child qualification</title>')
  const renderer = mainWindow.webContents
  service = new DesktopNativeViews(() => mainWindow, new DesktopBrowserGuests(() => undefined))
  service.bind(mainWindow)
  request = async input => {
    const result = await service.request(renderer, input)
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
    return result.result
  }
  admission = await request({ op: 'enter', owner: 'owner' })
  const scope = 'dsh-tab:v1:' + encodeURIComponent(JSON.stringify(['owner', 'sidebar', 'parent']))
  const placement = { x: 400, y: 0, width: 650, height: 650, visible: true, background: false }
  const slot = await request({ op: 'register', admission, scope })
  await request({ op: 'update', slot, placement })
  parentLease = (await request({ op: 'acquire', scope, workspace: 'native-child-acceptance' })).lease
  await request({ op: 'attach', lease: parentLease, slot })
  parent = webContents.getAllWebContents().find(contents => contents !== renderer)
  const send = renderer.send.bind(renderer)
  renderer.send = (channel, event) => {
    send(channel, event)
    if (channel !== 'dsh-desktop:native-child-event' || event.type !== 'created') return
    const child = event.child
    creations.push(child)
    const guest = webContents.getAllWebContents().find(contents => contents !== renderer && contents !== parent && !views.has(contents))
    views.add(guest)
    guest.once('close', () => log('child-close-event', { id: guest.id }))
    guest.once('destroyed', () => log('child-destroyed', { child: child.child }))
    if (child.url.includes('case=expired')) return
    adoptions.push((async () => {
      const slot = await request({ op: 'register', admission, scope: child.child })
      await request({ op: 'update', slot, placement })
      const adopted = await request({ op: 'child-adopt', request: child.request, slot })
      assert.deepEqual(adopted, { child: child.child, lease: child.lease })
      assert.deepEqual(await request({ op: 'child-adopt', request: child.request, slot }), adopted)
      const before = service.snapshot().length
      assert.equal((await service.request(parent, { op: 'child-adopt', request: child.request, slot })).ok, false)
      assert.equal(service.snapshot().length, before)
      const foreign = await service.request(renderer, { op: 'child-adopt', request: child.request, slot: slot + '-foreign' })
      assert.equal(foreign.ok, false)
    })())
  }
  await request({ op: 'command', lease: parentLease, method: 'Page.navigate', params: { url: origin + '/host' } })
  await new Promise(resolve => parent.once('did-finish-load', resolve))
  const originalUrl = parent.getURL()
  assert.equal(await parent.executeJavaScript(`window.open(${JSON.stringify(origin + '/child?case=unsupported')}) === null`), true)
  assert.equal(creations.length, 0)
  assert.equal(parent.getURL(), originalUrl)
  evidence.results['unregistered-native-opener-denied'] = { pass: true }
  assert.equal((await service.request(parent, { op: 'child-register', parent: scope, slot })).ok, false)
  await request({ op: 'child-register', parent: scope, slot })
  const results = await parent.executeJavaScript(`(async () => {
    const origin = ${JSON.stringify(origin)}, cross = ${JSON.stringify(cross)};
    const messages = [], results = {};
    window.addEventListener('message', e => messages.push({ ...e.data, senderOrigin: e.origin }));
    async function until(fn, label) {
      const end = Date.now() + 6000;
      while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
      throw new Error('timeout: ' + label);
    }
    async function check(name, fn) {
      try { results[name] = { pass: true, evidence: await fn() }; }
      catch (error) { results[name] = { pass: false, error: String(error) }; }
    }
    let same, foreign, immediate, named;
    await check('same-origin', async () => {
      same = window.open(origin + '/child?case=same', '_blank');
      const immediateUrlScript = same.eval('window.justOpenedValue = 19; window.justOpenedValue');
      if (immediateUrlScript !== 19) throw new Error('immediate URL child scripting failed');
      await until(() => messages.some(m => m.kind === 'loaded' && m.token === 'same'), 'same loaded');
      same.eval('window.fromOpener = 42');
      same.postMessage({kind:'probe', token:'same-reply'}, origin);
      await until(() => messages.some(m => m.token === 'same-reply'), 'same message');
      if (!same.firstOpener || same.fromOpener !== 42) throw new Error('opener/script missing');
      return { immediateUrlScript, firstOpener: same.firstOpener, scriptValue: same.fromOpener, reply: messages.find(m => m.token === 'same-reply') };
    });
    await check('cross-origin', async () => {
      foreign = window.open(cross + '/child?case=cross', '_blank');
      await until(() => messages.some(m => m.kind === 'loaded' && m.token === 'cross'), 'cross loaded');
      let blocked = false;
      try { void foreign.document.body; } catch (e) { blocked = e.name === 'SecurityError'; }
      foreign.postMessage({kind:'probe', token:'cross-reply'}, cross);
      await until(() => messages.some(m => m.token === 'cross-reply'), 'cross message');
      const reply = messages.find(m => m.token === 'cross-reply');
      if (!blocked || !reply.firstOpener) throw new Error('origin/opener checks failed');
      return { scriptingBlockedBySameOriginPolicy: blocked, reply };
    });
    await check('immediate-script', async () => {
      immediate = window.open('about:blank', '_blank');
      immediate.eval('window.immediateValue = 73; window.opener.postMessage({kind:"immediate", value:73}, "*")');
      const observed = immediate.immediateValue;
      await until(() => messages.some(m => m.kind === 'immediate'), 'immediate message');
      if (observed !== 73) throw new Error('immediate script failed');
      return { synchronousValue: observed, reply: messages.find(m => m.kind === 'immediate') };
    });
    await check('named-target', async () => {
      named = window.open(origin + '/child?case=named-first', 'native-named');
      await until(() => messages.some(m => m.token === 'named-first'), 'named first');
      const again = window.open(origin + '/child?case=named-second', 'native-named');
      await until(() => messages.some(m => m.token === 'named-second'), 'named second');
      if (again !== named) throw new Error('different WindowProxy');
      return { sameWindowProxy: again === named, finalUrl: named.location.href };
    });
    await check('form-post', async () => {
      const form = document.createElement('form');
      form.method = 'POST'; form.action = origin + '/child?case=post'; form.target = '_blank';
      const input = document.createElement('input'); input.name = 'payload'; input.value = 'kept + body';
      form.append(input); document.body.append(form); form.submit();
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        const records = await (await fetch(origin + '/observed-posts')).json();
        if (records.some(r => r.method === 'POST' && r.body === 'payload=kept+%2B+body')) return { records };
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error('POST body did not arrive');
    });
    await check('child-close', async () => {
      same.eval('window.close()');
      await until(() => same.closed === true, 'child closed');
      return { windowProxyClosed: same.closed };
    });
    return { results, messages };
  })()`)
  Object.assign(evidence.results, results.results)
  evidence.messages = results.messages
  evidence.receivedPosts = receivedPosts
  evidence.results['form-post'].pass &&= receivedPosts.some(p => p.method === 'POST' && p.body === 'payload=kept+%2B+body')
  evidence.results['browser-window-count'] = { pass: maxWindows === 1 && BrowserWindow.getAllWindows().length === 1,
    maximum: maxWindows, final: BrowserWindow.getAllWindows().length }
  const closeDeadline = Date.now() + 2000
  while (!evidence.events.some(e => e.event === 'child-destroyed') && Date.now() < closeDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  evidence.results['native-close-event'] = { pass: evidence.events.some(e => e.event === 'child-destroyed'),
    closeEvents: evidence.events.filter(e => ['child-close-event', 'child-destroyed'].includes(e.event)) }
  await Promise.all(adoptions)
  const count = creations.length
  assert.equal(count, 5, 'named targets reuse the same main-owned child')
  assert.equal(service.snapshot().length, 5, 'one parent and four surviving native children')
  const first = creations[0]
  assert.equal((await service.request(renderer, { op: 'child-adopt', request: first.request, slot })).code, 'BROWSER_GUEST_CLOSED')
  assert.equal(service.snapshot().length, 5)
  evidence.results['foreign-and-replayed-adoption-create-nothing'] = { pass: true }
  await parent.executeJavaScript(`window.expiredChild = window.open(${JSON.stringify(origin + '/child?case=expired')}); true`)
  const deadline = Date.now() + 12000
  while (!(await parent.executeJavaScript('window.expiredChild.closed')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(creations.length, count + 1)
  assert.equal(service.snapshot().length, 5)
  const expired = creations.at(-1)
  assert.equal((await service.request(renderer, { op: 'child-adopt', request: expired.request, slot })).code, 'BROWSER_CHILD_ADOPTION_TIMEOUT')
  assert.equal(await parent.executeJavaScript('window.expiredChild.closed'), true)
  assert.equal(service.snapshot().length, 5)
  evidence.results['expired-adoption-creates-nothing'] = { pass: true }
  await request({ op: 'leave', admission })
  assert.deepEqual(service.snapshot(), [])
  assert.equal(parent.isDestroyed(), true)
  assert.equal(creations.length, count + 1)
  evidence.results['authenticated-adoption-and-session-disposal'] = { pass: true, children: count, views: service.snapshot().length }
  finish()
}

function finish(error) {
  if (error) evidence.fatal = String(error?.stack || error)
  fs.writeFileSync(path.join(process.env.NATIVE_CHILD_EVIDENCE || __dirname, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log('RESULTS ' + JSON.stringify(evidence.results))
  for (const guest of views) if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
  for (const server of servers) server.close()
  app.exit(error || Object.values(evidence.results).some(r => !r.pass) ? 1 : 0)
}
setTimeout(() => finish(new Error('global timeout')), 60000).unref()
run().catch(finish)
