const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const origin = process.env.DSH_VIEWPORT_ORIGIN
const profile = process.env.DSH_VIEWPORT_PROFILE
const screenshots = process.env.DSH_TEST_SCREENSHOT_DIR
app.setPath('userData', profile)
app.commandLine.appendSwitch('force-device-scale-factor', '2')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, webPreferences: { webviewTag: true, backgroundThrottling: false } })
  await win.loadURL(origin)
  const rows = []
  for (const zoom of [1, 1.25, 0.8]) {
    win.webContents.setZoomFactor(zoom)
    rows.push(...await win.webContents.executeJavaScript('window.measureViewports()'))
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true })
      for (const kind of ['webview', 'iframe']) {
        await win.webContents.executeJavaScript(`window.showViewport('${kind}')`)
        writeFileSync(join(screenshots, `${kind}-${zoom}.png`), (await win.webContents.capturePage()).toPNG())
      }
      await win.webContents.executeJavaScript("window.showViewport('webview')")
    }
  }
  const lifecycle = await win.webContents.executeJavaScript('window.checkLifecycle()')
  console.log('VIEWPORT_RESULT=' + JSON.stringify({ rows, lifecycle }))
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
