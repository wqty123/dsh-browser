const electron = require('electron')
const { app, BrowserWindow, ipcMain, protocol } = electron
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')

const directory = process.env.NATIVE_SLOT_EVIDENCE
app.setPath('userData', path.join(directory, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const evidence = { electron: process.versions.electron, events: [] }
let window, service, policy, stopBridge, server, requestChannel
const log = (event, data) => { evidence.events.push({ event, ...data }); console.log(JSON.stringify({ event, ...data })) }
const timeout = setTimeout(() => finish(new Error('Native slot acceptance timed out')), 55000)

function region(source, name) {
  const marker = `//#region lib/types/${name}.js\n`
  const begin = source.indexOf(marker)
  assert.notEqual(begin, -1, `Production region ${name} is present`)
  return source.slice(begin + marker.length, source.indexOf('//#endregion', begin))
}

async function run() {
  await app.whenReady()
  const sourceRoot = process.env.DSH_SOURCE_ROOT
  const compiled = path.join(sourceRoot, 'apps/desktop/lib/types')
  const { DESKTOP_IPC } = await import(pathToFileURL(path.join(compiled, 'ipc.js')))
  const { SidebarSessionCookies } = await import(pathToFileURL(path.join(compiled, 'sidebar-session-cookies.js')))
  const { HarnessError } = await import(pathToFileURL(path.join(sourceRoot, 'packages/util/error/lib/types/index.js')))
  const source = fs.readFileSync(path.join(directory, 'main.js'), 'utf8')
  const context = vm.createContext({ ...electron, ...crypto, DESKTOP_IPC, SidebarSessionCookies, HarnessError, console,
    setTimeout, clearTimeout, URL, Buffer, fetch, process })
  vm.runInContext(region(source, 'browser-guests') + region(source, 'native-views')
    + ';globalThis.classes = { DesktopBrowserGuests, DesktopNativeViews }', context)
  const { DesktopBrowserGuests, DesktopNativeViews } = context.classes
  protocol.handle('dsh-app', () => new Response('<!doctype html><title>DSH native slot acceptance</title><style>body{margin:0;background:#253044;color:white}</style><h1>DSH sidebar native composition</h1>', { headers: { 'content-type': 'text/html' } }))
  window = new BrowserWindow({ width: 1100, height: 720, show: true, webPreferences: {
    preload: path.join(directory, 'preload-app.cjs'), nodeIntegration: false, contextIsolation: true,
    sandbox: true, webSecurity: true, webviewTag: false,
  } })
  policy = new DesktopBrowserGuests(() => undefined, process.env.DSH_HOME)
  service = new DesktopNativeViews(() => window, policy)
  service.bind(window)
  requestChannel = DESKTOP_IPC.nativeViewsRequest
  ipcMain.handle(requestChannel, async (event, input) => {
    assert.equal(event.sender, window.webContents)
    assert.equal(new URL(event.senderFrame.url).hostname, 'app')
    const result = await service.request(event.sender, input)
    if (input.op !== 'command') log('native-request', { op: input.op, placement: input.placement, ok: result.ok })
    return result
  })
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:rgb(24,180,92)}h1{padding:30px}</style><title>Native visible fixture</title><h1>Visible native sidebar page</h1><input aria-label="Username">')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await window.loadURL('dsh-app://app/')
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(directory, 'renderer.js'), 'utf8'))
  await window.webContents.executeJavaScript(`bootNativeSlot(${JSON.stringify(fs.readFileSync(path.join(directory, 'client.js'), 'utf8'))}, ${JSON.stringify(fs.readFileSync(path.join(directory, 'plugin/dist/client.cjs'), 'utf8'))}, ${process.env.NATIVE_SLOT_STATIC === '1'})`)
  const extension = await import(pathToFileURL(path.join(directory, 'plugin/desktop-bridge/main.mjs')))
  stopBridge = extension.start({ app, webContents: electron.webContents, mainWindow: () => window, dshHome: process.env.DSH_HOME,
    browserGuests: { protocolVersion: 1, snapshot: () => service.snapshot(),
      command: (...args) => service.scopedCommand(...args), release: (...args) => service.scopedRelease(...args),
      fetch: (...args) => service.scopedFetch(...args) } })
  const endpoint = path.join(process.env.DSH_HOME, 'dsh-builtin-browser-bridge.json')
  while (!fs.existsSync(endpoint)) await new Promise(resolve => setTimeout(resolve, 20))
  const child = spawn(process.env.NATIVE_SLOT_NODE, [path.join(__dirname, 'native-slot-tool-driver.mjs')], {
    env: { ...process.env, NATIVE_SLOT_URL: `http://127.0.0.1:${server.address().port}/` }, stdio: 'inherit',
  })
  const sample = setTimeout(async () => {
    evidence.loaded = { geometry: await window.webContents.executeJavaScript('slotGeometry()'),
      views: [...service.views.values()].map(native => ({ bounds: native.container.getBounds(), visible: native.container.getVisible(), state: native.state, title: native.view.webContents.getTitle() })) }
    console.log(JSON.stringify({ event: 'loaded', ...evidence.loaded }))
  }, 1000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(sample)
  await new Promise(resolve => setTimeout(resolve, 400))
  evidence.toolExit = code
  evidence.geometry = await window.webContents.executeJavaScript('slotGeometry()')
  evidence.zoom = window.webContents.getZoomFactor()
  evidence.native = [...service.views.values()].map(native => ({
    bounds: native.view.getBounds(), container: native.container.getBounds(), visible: native.container.getVisible(),
    state: native.state, url: native.view.webContents.getURL(),
    attached: window.contentView.children.includes(native.container),
    topmost: window.contentView.children.at(-1) === native.container,
  }))
  evidence.webviews = await window.webContents.executeJavaScript('document.querySelectorAll("webview").length')
  const screenshot = await window.capturePage()
  fs.writeFileSync(path.join(directory, 'window.png'), screenshot.toPNG())
  const display = electron.screen.getPrimaryDisplay()
  const sources = await electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
    width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor),
  } })
  fs.writeFileSync(path.join(directory, 'display.png'), sources[0].thumbnail.toPNG())
  const image = sources[0].thumbnail, size = image.getSize(), content = window.getContentBounds(), slot = evidence.geometry
  const x = Math.round((content.x + slot.x + slot.width - 60 - display.bounds.x) * size.width / display.size.width)
  const y = Math.round((content.y + slot.y + slot.height - 60 - display.bounds.y) * size.height / display.size.height)
  evidence.screenPixel = [...image.toBitmap().subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 4)]
  console.log(JSON.stringify(evidence))
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(evidence, null, 2))
  assert.equal(code, 0, 'Browser tools open and capture the native page')
  assert.equal(evidence.geometry.scale, 1.25)
  assert.equal(evidence.native.length, 1)
  const native = evidence.native[0]
  assert.equal(native.visible, true)
  assert.equal(native.attached, true)
  assert.equal(native.topmost, true)
  assert.ok(native.bounds.width > 0 && native.bounds.height > 0)
  for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(native.container[axis] - slot[axis] * evidence.zoom) <= 1, `Native ${axis} matches slot`)
  assert.equal(native.state.stage, 'document')
  assert.equal(evidence.webviews, 0)
  assert.deepEqual(evidence.screenPixel, [92, 180, 24, 255], 'The native page is drawn above the shell on screen')
  const toolImage = electron.nativeImage.createFromPath(path.join(directory, 'tool.png')), toolSize = toolImage.getSize()
  const offset = ((toolSize.height - 60) * toolSize.width + toolSize.width - 60) * 4
  assert.deepEqual([...toolImage.toBitmap().subarray(offset, offset + 4)], [92, 180, 24, 255], 'The browser tool captures the native document')
  console.log('Scaled packaged native visibility, slot bounds and browser-tool screenshot: PASS')
}

async function finish(error) {
  clearTimeout(timeout)
  if (error) { console.error(error); evidence.error = String(error); fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(evidence, null, 2)) }
  stopBridge?.()
  await policy?.shutdown().catch(console.error)
  server?.close()
  if (requestChannel) ipcMain.removeHandler(requestChannel)
  window?.destroy()
  app.exit(error ? 1 : 0)
}
run().then(() => finish(), finish)
