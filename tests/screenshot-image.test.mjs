import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-screenshot-image-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))
const { apply } = await import('../lib/tool-browser/index.js')
const { ElectronBrowserProvider } = await import('../lib/browser-electron/provider.js')
const { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_WIDTH, SCREENSHOT_MAX_HEIGHT, screenshotBytes } = await import('../lib/tool-browser/screenshot-image.js')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const dataUrl = `data:image/png;base64,${png.toString('base64')}`

function mount({ modalities = ['text', 'image'], unknown = false, resolve, shot, ref = {}, web = false, native = false } = {}) {
  const calls = [], tools = new Map(), cleanups = []
  const host = {
    createView: () => ({ id: 'native-view', sendCommand: async () => ({}), capture: async options => {
      calls.push(['native-capture', options])
      return { base64: png.toString('base64'), mime: 'image/png', width: 1, height: 1 }
    } }),
    destroyView() {}, groupView() {}, onUserAction() {}, showView() {}, async presentView() {},
  }
  const provider = new ElectronBrowserProvider(host)
  const browser = {
    openPanel: async () => web ? undefined : native ? provider.open() : 'desktop-sidebar',
    exists: () => true, close: async () => {}, openUrl: async () => {},
    snapshot: async () => ({ url: 'https://example.test/', title: 'Page', elements: [], truncated: false }),
    screenshot: async (session, options, signal) => {
      calls.push(['capture', options, signal])
      return shot ?? (native ? provider.screenshot(session, options, signal) : { dataUrl, width: 1, height: 1, path: '/downloads/shot.png' })
    },
  }
  const controller = new AbortController()
  const exec = { signal: controller.signal, agent: { id: 'screenshot-owner', model: { current: () => ({ provider: 'test', model: 'active-model' }) },
    ctx: { effect: fn => { cleanups.push(fn()) } } } }
  const ctx = {
    get: name => name === 'browser' ? browser : undefined,
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} }, effect() {},
    llm: { resolveModelInfo: async (...args) => {
      calls.push(['model', ...args])
      return resolve ? resolve(...args) : unknown ? {} : { inputModalities: modalities }
    } },
    attachments: { saveImage: async input => {
      calls.push(['save-image', input])
      assert.deepEqual(input.data, png)
      assert.equal(input.mediaType, 'image/png')
      assert.deepEqual(Object.keys(input).sort(), ['data', 'mediaType'], 'no source URL, local path or display name enters attachment metadata')
      return { attachmentId: 'opaque-image-id', mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'must-not-propagate', ...ref }
    } },
  }
  apply(ctx)
  return { calls, ctx, exec, controller, tools, async open() { await tools.get('dsh_browser_open').execute({ url: 'https://example.test/' }, exec) },
    async capture(args = {}) {
      const tool = tools.get('dsh_browser_screenshot')
      const result = await tool.execute(args, exec)
      return { result, content: tool.output.render(args, result) }
    }, async dispose() { for (const cleanup of cleanups) await cleanup?.(); await provider.dispose() } }
}

test('Desktop native capture → attachment saveImage → model-facing image block, without read_image', async t => {
  const h = mount({ native: true }); t.after(() => h.dispose())
  await h.open()
  const { result, content } = await h.capture({ maxWidth: 9000, maxHeight: 9000, format: 'png' })
  assert.deepEqual(content.map(block => block.type), ['text', 'image'])
  assert.equal(content[1].attachment.attachmentId, 'opaque-image-id')
  assert.equal(content[1].attachment.mediaType, 'image/png')
  const saved = h.calls.find(([name]) => name === 'save-image')[1]
  assert.equal(saved.data.toString('base64'), png.toString('base64'), 'valid canonical base64 round-trips unchanged')
  assert.deepEqual([...saved.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(result.bytes, png.length)
  assert.equal('dataUrl' in result, false, 'raw image payload is not retained in tool metadata')
  assert.equal('name' in result.attachment, false)
  const native = h.calls.find(([name]) => name === 'native-capture')[1]
  assert.equal(native.maxWidth, SCREENSHOT_MAX_WIDTH)
  assert.equal(native.maxHeight, SCREENSHOT_MAX_HEIGHT)
  assert.deepEqual(h.calls.find(([name]) => name === 'model').slice(1), ['test', 'active-model', h.exec.signal])
})

for (const [name, options] of [
  ['vision off', { modalities: ['text'] }], ['unknown model capabilities', { unknown: true }],
  ['metadata lookup unavailable', { resolve: async () => { throw new Error('unavailable') } }],
]) test(`${name} → text/path/metadata only, no attachment or image payload`, async t => {
  const h = mount(options); t.after(() => h.dispose())
  await h.open()
  const { result, content } = await h.capture()
  assert.deepEqual(content.map(block => block.type), ['text'])
  assert.match(content[0].text, /saved to \/downloads\/shot.png/)
  assert.equal(result.bytes, png.length)
  assert.equal('attachment' in result, false)
  assert.equal('dataUrl' in result, false)
  assert.equal(h.calls.some(([name]) => name === 'save-image'), false)
})

test('missing model/service also fails closed to text only', async t => {
  const h = mount(); t.after(() => h.dispose())
  delete h.exec.agent.model; delete h.ctx.llm
  await h.open()
  assert.deepEqual((await h.capture()).content.map(block => block.type), ['text'])
})

test('Web iframe returns explicit unavailable, without native capture or image attachment', async t => {
  const h = mount({ web: true }); t.after(() => h.dispose())
  await h.open()
  await assert.rejects(h.capture(), /Web 侧栏暂不支持截图：iframe 无法被网页静默截图/)
  assert.deepEqual(h.calls, [])
})

test('capture size bound rejects oversized images before attachment persistence', async t => {
  const h = mount({ shot: { dataUrl: `data:image/png;base64,${Buffer.alloc(SCREENSHOT_MAX_BYTES + 1).toString('base64')}` } })
  t.after(() => h.dispose()); await h.open()
  await assert.rejects(h.capture(), /4 MiB/)
  assert.equal(h.calls.some(([name]) => name === 'save-image'), false)
})

test('intrinsic attachment dimensions and encoded size cannot exceed the delivery bounds', async t => {
  for (const ref of [{ width: SCREENSHOT_MAX_WIDTH + 1 }, { height: SCREENSHOT_MAX_HEIGHT + 1 }, { bytes: SCREENSHOT_MAX_BYTES + 1 }, { width: 0 }]) {
    const h = mount({ ref }); t.after(() => h.dispose()); await h.open()
    await assert.rejects(h.capture(), /size\/dimension limits/)
  }
})

test('smaller requested dimensions and JPEG quality reach the capture seam', async t => {
  const h = mount(); t.after(() => h.dispose()); await h.open()
  await h.capture({ maxWidth: 640, maxHeight: 480, format: 'jpeg', quality: 70, fullPage: true })
  assert.deepEqual(h.calls.find(([name]) => name === 'capture')[1], { maxWidth: 640, maxHeight: 480, format: 'jpeg', quality: 70, fullPage: true })
  await assert.rejects(h.capture({ maxWidth: 0 }), /positive finite/)
})

test('invalid/empty/unsupported base64 is refused; PNG and JPEG MIME are explicit', () => {
  for (const value of ['', 'data:image/png;base64,', 'data:image/png;base64,!!', 'data:image/png;base64,AB==', 'data:text/html;base64,AA==']) {
    assert.throws(() => screenshotBytes(value), /PNG or JPEG|invalid base64/)
  }
  assert.equal(screenshotBytes(dataUrl).mediaType, 'image/png')
  assert.equal(screenshotBytes('data:image/jpeg;base64,/9j/2Q==').mediaType, 'image/jpeg')
})

test('attachment errors and turn cancellation never become successful image results', async t => {
  const h = mount(); t.after(() => h.dispose()); await h.open()
  h.ctx.attachments.saveImage = async () => { throw new Error('disk unavailable') }
  await assert.rejects(h.capture(), /disk unavailable/)
  h.controller.abort(new Error('turn stopped'))
  await assert.rejects(h.capture(), /turn stopped/)
})

test('installed rc.5 attachment service persists/decodes the native image block (opt-in)', {
  skip: !process.env.DSH_TEST_REAL_HOST && 'set DSH_TEST_REAL_HOST to an installed rc.5 runtime',
}, async t => {
  const require = createRequire(join(process.env.DSH_TEST_REAL_HOST, 'package.json'))
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const { LocalAttachmentStore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const ctx = new Context()
  const store = new LocalAttachmentStore(ctx, LocalAttachmentStore.Config({ dshHome: join(home, 'real-store') }))
  const h = mount({ native: true }); t.after(() => h.dispose())
  h.ctx.attachments = store
  await h.open()
  const { content } = await h.capture()
  const stored = await store.readImage(content[1].attachment)
  assert.equal(stored.ref.mediaType, 'image/png')
  assert.equal(stored.ref.width, 1)
  assert.equal(stored.ref.height, 1)
  assert.equal(Buffer.from(stored.data).toString('base64'), png.toString('base64'))
})
