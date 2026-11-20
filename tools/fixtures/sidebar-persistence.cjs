const { app, BrowserWindow, WebContentsView } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.setPath('userData', process.env.PERSISTENCE_USER_DATA)
app.commandLine.appendSwitch('disable-gpu')
setTimeout(() => { console.error('Sidebar persistence fixture timed out'); app.exit(1) }, 30_000).unref()
app.whenReady().then(async () => {
  const source = process.env.DSH_SOURCE_ROOT
  const { DesktopBrowserGuests } = await import(pathToFileURL(path.join(source, 'apps/desktop/lib/types/browser-guests.js')))
  const window = new BrowserWindow({ show: false, webPreferences: { webviewTag: false, sandbox: true } })
  const policy = new DesktopBrowserGuests(() => undefined, process.env.DSH_HOME)
  const reservation = policy.acquire(window.webContents, 'workspace-one', true)
  const second = policy.acquire(window.webContents, 'workspace-two', true)
  assert.equal(reservation.partition, second.partition)
  const view = new WebContentsView({ webPreferences: { partition: reservation.partition, sandbox: true,
    contextIsolation: true, nodeIntegration: false, webviewTag: false } })
  policy.bindNative(window.webContents, reservation.lease, view.webContents)
  window.contentView.addChildView(view)
  await view.webContents.loadURL(process.env.PERSISTENCE_URL)
  const observed = await view.webContents.executeJavaScript('({cookie:document.cookie, storage:localStorage.getItem("login")})')
  if (process.env.PERSISTENCE_MODE === 'read') {
    assert.match(observed.cookie, /sidebar_login=retained/)
    assert.equal(observed.storage, 'retained')
  } else {
    assert.equal(observed.cookie, '')
    assert.equal(observed.storage, null)
    if (process.env.PERSISTENCE_MODE === 'write') {
      await view.webContents.executeJavaScript('document.cookie="sidebar_login=retained;Max-Age=86400;SameSite=Lax";localStorage.setItem("login","retained")')
      await view.webContents.session.cookies.flushStore()
      view.webContents.session.flushStorageData()
    }
  }
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await policy.release(window.webContents, reservation.lease)
  await policy.release(window.webContents, second.lease)
  console.log(JSON.stringify({ mode: process.env.PERSISTENCE_MODE, partition: reservation.partition, observed, result: 'PASS' }))
  window.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
