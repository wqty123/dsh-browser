import { ElectronWebviewPresentation } from '/src/client/electron/ElectronWebviewPresentation.ts'
import { IframePresentation } from '/src/client/view/IframePresentation.ts'

const sidebar = document.getElementById('sidebar')
const viewport = document.getElementById('viewport')
const tick = () => new Promise(resolve => setTimeout(resolve, 30))
let observation
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await check()
    if (result) return result
    await tick()
  }
  throw new Error('viewport did not settle: ' + JSON.stringify(observation))
}
const hostSize = () => ({ width: viewport.clientWidth, height: viewport.clientHeight, dpr: devicePixelRatio })
const aligned = (guest, host) => Math.abs(guest.width - host.width) <= 1 && Math.abs(guest.height - host.height) <= 1 && Math.abs(guest.dpr - host.dpr) < 0.01

let state
async function initialize() {
  if (state) return state
  const seed = document.createElement('webview')
  seed.setAttribute('partition', 'persist:layout')
  seed.setAttribute('src', '/guest')
  const seedReady = new Promise(resolve => seed.addEventListener('dom-ready', resolve, { once: true }))
  viewport.append(seed)
  await seedReady
  seed.setZoomFactor(0.8)
  await until(async () => Math.abs(await seed.executeJavaScript('devicePixelRatio') - 1.6) < 0.01)
  seed.remove()
  const presentation = new ElectronWebviewPresentation({ mounted() {}, unmounted() { presentation.clear() } })
  const unmount = presentation.mount('viewport')
  const native = presentation.createElement({ lease: 'layout', partition: 'persist:layout' })
  native.setAttribute('src', '/guest')
  let ready = false
  native.addEventListener('dom-ready', () => { ready = true })
  presentation.present(native)
  await until(() => ready)
  const iframe = new IframePresentation({ loaded() {}, failed() {}, remounted() {} })
  const remove = iframe.mount('viewport')
  iframe.show({ target: { url: location.origin + '/guest', title: 'Viewport' }, revision: 1, sandboxed: true })
  state = { native, presentation, unmount, iframe, remove }
  return state
}

window.measureViewports = async () => {
  const rows = []
  const { native } = await initialize()
  for (const width of [500, 280, 720]) {
    sidebar.style.width = width + 'px'
    sidebar.style.height = width === 280 ? '420px' : '600px'
    const row = await until(async () => {
      const guest = await native.executeJavaScript('({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})')
      const host = hostSize()
      observation = { guest, host, zoom: native.getZoomFactor(), bounds: native.getBoundingClientRect().toJSON() }
      return aligned(guest, host) && { kind: 'webview', guest, host }
    })
    rows.push(row)
  }
  await native.loadURL(location.origin + '/next-page')
  await until(async () => aligned(await native.executeJavaScript('({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})'), hostSize()))
  const frame = viewport.querySelector('iframe')
  let measurement
  const receive = event => { if (event.origin === 'null' && event.source === frame.contentWindow && event.data?.type === 'measurement') measurement = event.data }
  window.addEventListener('message', receive)
  for (const width of [500, 280, 720]) {
    sidebar.style.width = width + 'px'
    sidebar.style.height = width === 280 ? '420px' : '600px'
    const row = await until(async () => {
      measurement = undefined
      frame.contentWindow.postMessage('measure', '*')
      await tick()
      const host = hostSize()
      return measurement && aligned(measurement, host) && { kind: 'iframe', guest: measurement, host }
    })
    rows.push(row)
  }
  window.removeEventListener('message', receive)
  return rows
}

window.showViewport = async kind => {
  viewport.querySelector('iframe').style.visibility = kind === 'iframe' ? 'visible' : 'hidden'
  state.native.style.visibility = kind === 'webview' ? 'visible' : 'hidden'
  await tick()
}

window.checkLifecycle = async () => {
  state.unmount()
  state.presentation.dispose()
  state.remove()
  state.iframe.dispose()
  const presentation = new ElectronWebviewPresentation({ mounted() {}, unmounted() { presentation.clear() } })
  let writes = 0, resolve
  const element = document.createElement('div')
  element.executeJavaScript = () => new Promise(done => { resolve = done })
  element.getZoomFactor = () => 0.8
  element.setZoomFactor = () => { writes++ }
  const remove = presentation.mount('viewport')
  presentation.present(element)
  element.dispatchEvent(new Event('dom-ready'))
  presentation.clear()
  resolve(1.6)
  await tick()
  const pendingIgnored = writes === 0
  remove()
  const detached = viewport.children.length === 0
  const oldError = console.error
  let errors = 0
  console.error = () => { errors++ }
  const removeAgain = presentation.mount('viewport')
  element.executeJavaScript = async () => { throw new Error('guest unavailable') }
  presentation.present(element)
  element.dispatchEvent(new Event('dom-ready'))
  await tick()
  console.error = oldError
  const errorReported = errors === 1
  presentation.dispose()
  removeAgain()
  return { detached, disposed: viewport.children.length === 0, pendingIgnored, emptySafe: writes === 0, errorReported }
}
