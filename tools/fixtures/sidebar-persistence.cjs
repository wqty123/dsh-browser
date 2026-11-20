const { app, BrowserWindow, WebContentsView } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.setPath('userData', process.env.PERSISTENCE_USER_DATA)
app.commandLine.appendSwitch('disable-gpu')
setTimeout(() => { console.error('Sidebar persistence fixture timed out'); app.exit(1) }, 30_000).unref()
app.whenReady().then(async () => {
  const source = process.env.DSH_SOURCE_ROOT, mode = process.env.PERSISTENCE_MODE
  const { DesktopBrowserGuests } = await import(pathToFileURL(path.join(source, 'apps/desktop/lib/types/browser-guests.js')))
  const window = new BrowserWindow({ show: false, webPreferences: { webviewTag: false, sandbox: true } })
  const policy = new DesktopBrowserGuests(() => undefined, process.env.DSH_HOME)
  await Promise.all([policy.preparePersistent(), policy.preparePersistent()])
  let reservation = policy.acquire(window.webContents, 'workspace-one', true)
  const second = policy.acquire(window.webContents, 'workspace-two', true)
  assert.equal(reservation.partition, second.partition)
  const makeView = () => {
    const view = new WebContentsView({ webPreferences: { partition: reservation.partition, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    policy.bindNative(window.webContents, reservation.lease, view.webContents)
    window.contentView.addChildView(view)
    return view
  }
  let view = makeView()
  const ses = view.webContents.session, url = process.env.PERSISTENCE_URL
  const file = path.join(process.env.DSH_HOME, 'dsh-builtin-browser-host', 'desktop-session-cookies.json')
  const saved = async () => JSON.parse(await fs.readFile(file, 'utf8')).cookies
  await view.webContents.loadURL(url)
  const observed = await view.webContents.executeJavaScript('({cookie:document.cookie, storage:localStorage.getItem("login"), firstCookie:window.firstCookie})')
  const empty = mode === 'empty' || mode === 'write'
  const httpCleared = mode === 'read-http-clear'
  if (empty || httpCleared) {
    assert.equal(observed.cookie, '')
    assert.equal(observed.firstCookie, '')
    assert.equal(observed.storage, null)
    if (empty) assert.equal((await ses.cookies.get({})).length, 0)
  } else {
    assert.match(observed.cookie, /sidebar_login=retained/)
    assert.equal(observed.storage, 'retained')
    if (['read-deleted', 'clear'].includes(mode)) {
      assert.doesNotMatch(observed.firstCookie, /sidebar_session=|sidebar_js_session=/)
    } else {
      assert.match(observed.firstCookie, /sidebar_session=retained/)
      const [session] = await ses.cookies.get({ name: 'sidebar_session' })
      assert.equal(session.session, true)
      assert.equal(session.expirationDate, undefined)
      assert.equal(session.httpOnly, true)
      assert.equal(session.hostOnly, true)
      assert.equal(session.sameSite, 'lax')
    }
    if (['read-replaced', 'crash', 'read-crash', 'delete', 'read-deleted', 'clear'].includes(mode)) {
      const [replacement] = await ses.cookies.get({ name: 'sidebar_replaced' })
      assert.equal(replacement.session, false)
      assert.equal(replacement.value, 'new-persistent')
    }
    if (mode === 'read-crash') assert.match(observed.firstCookie, /sidebar_crash=checkpoint/)
  }
  if (mode === 'write') {
    await view.webContents.executeJavaScript('document.cookie="sidebar_login=retained;Max-Age=86400;SameSite=Lax";document.cookie="sidebar_js_session=retained;SameSite=Lax";localStorage.setItem("login","retained")')
    await ses.cookies.set({ url, name: 'sidebar_session', value: 'retained', httpOnly: true, sameSite: 'lax' })
    await ses.cookies.set({ url, name: 'sidebar_replaced', value: 'old-session', httpOnly: true })
    await ses.cookies.set({ url: 'https://secure.example.test/', name: 'sidebar_secure', value: '"quoted"',
      secure: true, httpOnly: true, sameSite: 'strict' })
    await ses.cookies.set({ url: 'https://scope.example.test/', domain: '.example.test',
      name: 'sidebar_domain', value: 'domain', secure: true, httpOnly: true, sameSite: 'no_restriction' })
    await policy.reconcilePersistent()
    ses.flushStorageData()
    await policy.release(window.webContents, reservation.lease)
    window.contentView.removeChildView(view)
    reservation = policy.acquire(window.webContents, 'workspace-three', true)
    assert.equal(reservation.partition, second.partition)
    view = makeView()
    await view.webContents.loadURL(url)
    assert.equal(await view.webContents.executeJavaScript('localStorage.getItem("login")'), 'retained')
    assert.equal((await ses.cookies.get({ name: 'sidebar_session' })).length, 1)
  }
  if (!['empty', 'clear'].includes(mode)) {
    const [secure] = await ses.cookies.get({ name: 'sidebar_secure' })
    assert.equal(secure.session, true)
    assert.equal(secure.secure, true)
    assert.equal(secure.httpOnly, true)
    assert.equal(secure.hostOnly, true)
    assert.equal(secure.sameSite, 'strict')
    assert.equal(secure.value, '"quoted"')
    const [domain] = await ses.cookies.get({ name: 'sidebar_domain' })
    assert.equal(domain.hostOnly, false)
    assert.equal(domain.domain, '.example.test')
    assert.equal(domain.sameSite, 'no_restriction')
  }
  if (mode === 'replace') {
    await ses.cookies.set({ url, name: 'sidebar_replaced', value: 'new-persistent', httpOnly: true,
      expirationDate: Date.now() / 1000 + 86400 })
    await policy.reconcilePersistent()
    assert.equal((await saved()).some(cookie => cookie.name === 'sidebar_replaced'), false)
  }
  if (mode === 'delete') {
    await ses.cookies.remove(url, 'sidebar_session')
    await ses.cookies.set({ url, name: 'sidebar_js_session', value: '', expirationDate: 1 })
    await policy.reconcilePersistent()
    assert.equal((await saved()).some(cookie => ['sidebar_session', 'sidebar_js_session'].includes(cookie.name)), false)
  }
  if (mode === 'http-clear') {
    await view.webContents.executeJavaScript('fetch("/clear-site-data").then(()=>true)')
    await policy.reconcilePersistent()
    assert.equal((await ses.cookies.get({ url })).length, 0)
    assert.equal(await view.webContents.executeJavaScript('localStorage.getItem("login")'), null)
    assert.equal((await saved()).some(cookie => cookie.domain === '127.0.0.1'), false)
  }
  if (mode === 'clear') {
    await ses.clearStorageData({ storages: ['cookies', 'localstorage'] })
    await policy.reconcilePersistent()
    assert.equal((await saved()).length, 0)
  }
  if (mode === 'crash') {
    await ses.cookies.set({ url, name: 'sidebar_crash', value: 'checkpoint', httpOnly: true })
    await policy.reconcilePersistent()
    assert.equal((await saved()).some(cookie => cookie.name === 'sidebar_crash'), true)
    console.log('Crash after completed Sidebar checkpoint: PASS')
    process.kill(process.pid, 'SIGKILL')
    return
  }
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await policy.release(window.webContents, reservation.lease)
  await policy.release(window.webContents, second.lease)
  await policy.shutdown()
  assert.equal(ses.cookies.listenerCount('changed'), 0)
  console.log(JSON.stringify({ mode, partition: reservation.partition, result: 'PASS' }))
  window.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
