import assert from 'node:assert/strict'
import { rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const evidenceDir = resolve(process.env.NATIVE_SLOT_EVIDENCE)
const root = resolve(evidenceDir, 'plugin')
const { DesktopBridgeViewHost } = await import(pathToFileURL(resolve(root, 'lib/browser-electron/desktop-bridge-host.js')))
const { ElectronBrowserProvider } = await import(pathToFileURL(resolve(root, 'lib/browser-electron/provider.js')))
const { apply } = await import(pathToFileURL(resolve(root, 'lib/tool-browser/index.js')))
const host = await DesktopBridgeViewHost.discover()
assert.ok(host, 'The production main extension bridge is discoverable')
const provider = new ElectronBrowserProvider(host, { history: { enabled: false }, downloadDir: evidenceDir })
const tools = new Map(), cleanups = []
const browser = new Proxy(provider, { get(target, property) {
  if (property === 'openPanel') return target.open.bind(target)
  const member = target[property]
  return typeof member === 'function' ? member.bind(target) : member
} })
apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, effect() {},
  get: name => name === 'browser' ? browser : undefined })
const exec = { signal: AbortSignal.timeout(40000), agent: { id: 'session-packaged',
  session: { header: { cwd: process.env.DSH_HOME } }, ctx: { effect: effect => { cleanups.push(effect()) } } } }
try {
  const opened = await tools.get('dsh_browser_open').execute({ url: process.env.NATIVE_SLOT_URL }, exec)
  assert.equal(opened.title, 'Native visible fixture')
  const savePath = resolve(evidenceDir, 'tool.png')
  rmSync(savePath, { force: true })
  const shot = await tools.get('dsh_browser_screenshot').execute({ savePath }, exec)
  assert.equal(shot.path, savePath)
  const size = typeof shot.bytes === 'number' ? shot.bytes : statSync(savePath).size
  assert.ok(size > 1000, `Expected saved screenshot > 1000 bytes, got ${size}`)
  console.log('dsh_browser_open -> snapshot -> dsh_browser_screenshot: PASS')
  process.exit(0)
} catch (error) { console.error(error); process.exit(1) }
