import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.env.NATIVE_SLOT_EVIDENCE, 'plugin')
const { DesktopBridgeViewHost } = await import(pathToFileURL(resolve(root, 'lib/browser-electron/desktop-bridge-host.js')))
const { ElectronBrowserProvider } = await import(pathToFileURL(resolve(root, 'lib/browser-electron/provider.js')))
const { apply } = await import(pathToFileURL(resolve(root, 'lib/tool-browser/index.js')))
const host = await DesktopBridgeViewHost.discover()
assert.ok(host, 'The production main extension bridge is discoverable')
const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
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
  const shot = await tools.get('dsh_browser_screenshot').execute({}, exec)
  assert.match(shot.dataUrl, /^data:image\/png;base64,/)
  const data = Buffer.from(shot.dataUrl.split(',')[1], 'base64')
  assert.ok(data.length > 1000)
  writeFileSync(resolve(process.env.NATIVE_SLOT_EVIDENCE, 'tool.png'), data)
  console.log('dsh_browser_open -> snapshot -> dsh_browser_screenshot: PASS')
  process.exit(0)
} catch (error) { console.error(error); process.exit(1) }
