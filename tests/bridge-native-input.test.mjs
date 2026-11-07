import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const pages = new Map()
globalThis.__nativeInputElectron = {
  app: { whenReady: async () => {}, on() {}, getPath: () => tmpdir() },
  webContents: { getAllWebContents: () => [...pages.values()], fromId: id => pages.get(id) },
}
const folder = mkdtempSync(join(tmpdir(), 'bridge-native-input-'))
let source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
source = source.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__nativeInputElectron')
source = source.replace(/^start\(\)$/m, '').replace(/^main\(\)$/m, '')
source += '\nexport { sendCdp, nativeKeyEvent };\n'
writeFileSync(join(folder, 'bridge.mjs'), source)
const { sendCdp, nativeKeyEvent } = await import(pathToFileURL(join(folder, 'bridge.mjs')))
after(() => { delete globalThis.__nativeInputElectron; assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }) })

function page(id, type = 'webview') {
  const seen = { text: [], keys: [], cdp: [] }
  const guest = {
    id, getType: () => type, isDestroyed: () => false,
    insertText: async text => { seen.text.push(text) },
    sendInputEvent: event => { seen.keys.push(event) },
    focus: () => { assert.fail('input must preserve OS focus') },
    debugger: { isAttached: () => true, sendCommand: async (method, params) => { seen.cdp.push({ method, params }); return {} } },
  }
  pages.set(id, guest)
  return { guest, seen }
}

test('webview text and keys target the requested guest without CDP redirection or focus', async () => {
  pages.clear()
  const first = page(1), second = page(2)
  await sendCdp(2, 'Input.insertText', { text: '目标页面' })
  await sendCdp(2, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace' })
  await sendCdp(2, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace' })
  assert.deepEqual(first.seen, { text: [], keys: [], cdp: [] })
  assert.deepEqual(second.seen.text, ['目标页面'])
  assert.deepEqual(second.seen.keys.map(e => [e.type, e.keyCode]), [['keyDown', 'Backspace'], ['keyUp', 'Backspace']])
  assert.deepEqual(second.seen.cdp, [])
})

test('Enter and Space retain character input while key release adds no second character', async () => {
  const { seen } = page(3)
  await sendCdp(3, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' })
  await sendCdp(3, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', text: '\r' })
  await sendCdp(3, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', text: ' ' })
  assert.deepEqual(seen.keys.map(e => [e.type, e.keyCode]), [['keyDown', 'Enter'], ['char', '\r'], ['keyUp', 'Enter'], ['keyDown', 'Space'], ['char', ' ']])
})

test('arrows, modifier bits and keypad flags survive native key conversion', () => {
  assert.deepEqual(nativeKeyEvent({ type: 'rawKeyDown', key: 'ArrowLeft', modifiers: 15, location: 3, autoRepeat: true }), {
    type: 'keyDown', keyCode: 'Left', modifiers: ['alt', 'control', 'meta', 'shift', 'isKeypad', 'isAutoRepeat'],
  })
  assert.throws(() => nativeKeyEvent({ type: 'wrong', key: 'Enter' }), /type/)
  assert.throws(() => nativeKeyEvent({ type: 'keyDown' }), /key/)
})

test('native failures reject and recover the guest queue without falling back to another input channel', async () => {
  const { guest, seen } = page(4)
  guest.insertText = async () => { throw new Error('renderer unavailable') }
  await assert.rejects(sendCdp(4, 'Input.insertText', { text: 'x' }), /renderer unavailable/)
  await sendCdp(4, 'Runtime.evaluate', { expression: '1' })
  assert.deepEqual(seen.cdp.map(e => e.method), ['Runtime.evaluate'])
})

test('non-webview targets retain their normal CDP path', async () => {
  const { seen } = page(5, 'window')
  await sendCdp(5, 'Input.insertText', { text: 'window' })
  assert.deepEqual(seen.text, [])
  assert.equal(seen.cdp[0].method, 'Input.insertText')
})
