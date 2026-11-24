/**
 * Host feature probes: runtime checks, not host version strings, decide what the plugin uses.
 * The static guard keeps those checks in src/compat/host-features.ts and pins the deep
 * `@deepseek-ai/<pkg>/src/...` imports to the ones whose symbols no package export offers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopBrowserBridge, nativeChildTabs, nativeViews, ptcRuntimeActive, registerTool, urlChildTabs } from '../lib/compat/host-features.js'

test('PTC mode is the presence of the ptcRuntime service, and a throwing lookup is not PTC', () => {
  assert.equal(ptcRuntimeActive({ get: name => name === 'ptcRuntime' ? {} : undefined }), true)
  assert.equal(ptcRuntimeActive({ get: () => undefined }), false)
  assert.equal(ptcRuntimeActive({}), false)
  assert.equal(ptcRuntimeActive({ get: () => { throw new Error('no service') } }), false)
})

test('with a scoped executor registry, PTC mode is the agent selecting an executor that exposes run_code', () => {
  const get = name => name === 'ptcRuntime' ? {} : undefined
  const ptc = { describe: () => ({ schemas: [], knownNames: ['run_code'] }) }
  const native = { describe: tools => ({ schemas: tools }) }
  const ptcAgent = {}
  const tools = { selectExecutor: agent => agent === ptcAgent ? ptc : native }
  assert.equal(ptcRuntimeActive({ get, tools }, { agent: ptcAgent }), true)
  assert.equal(ptcRuntimeActive({ get, tools }, { agent: {} }), false)
  assert.equal(ptcRuntimeActive({ get, tools }), false)
  assert.equal(ptcRuntimeActive({ get: () => undefined, tools }, { agent: ptcAgent }), false)
  assert.equal(ptcRuntimeActive({ get, tools: { selectExecutor: () => { throw new Error('unavailable') } } }, { agent: {} }), false)
})

test('`when` is passed only when given, and an older registry that ignores it still registers', () => {
  const calls = []
  const registry = { register(tool, options) { calls.push([tool, options, this === registry]); return 'disposer' } }
  const when = () => true
  assert.equal(registerTool(registry, 'a', when), 'disposer')
  registerTool(registry, 'b')
  assert.deepEqual(calls, [['a', { when }, true], ['b', undefined, true]])
  const legacy = { tools: [], register(tool) { this.tools.push(tool) } }
  registerTool(legacy, 'c', when)
  assert.deepEqual(legacy.tools, ['c'])
})

test('the desktop bridge is used only at protocolVersion 1', () => {
  const browser = { acquire() {} }
  assert.equal(desktopBrowserBridge({ dshDesktop: { protocolVersion: 1, browser } }), browser)
  assert.equal(desktopBrowserBridge({ dshDesktop: { protocolVersion: 2, browser } }), undefined)
  assert.equal(desktopBrowserBridge({ dshDesktop: { browser } }), undefined)
  assert.equal(desktopBrowserBridge({ dshDesktop: null }), undefined)
  assert.equal(desktopBrowserBridge({}), undefined)
})

test('native views and child tabs are selected by their own protocol versions', () => {
  const views = { protocolVersion: 1 }
  assert.equal(nativeViews({ dshDesktop: { browser: { nativeViews: views } } }), views)
  assert.equal(nativeViews({ nativeViews: views }), views, 'a bridge object is accepted directly')
  assert.equal(nativeViews({ nativeViews: { protocolVersion: 2 } }), undefined)
  assert.equal(nativeViews({}), undefined)
  const url = { protocolVersion: 1 }, native = { protocolVersion: 2 }
  assert.equal(urlChildTabs({ childTabs: url }), url)
  assert.equal(urlChildTabs({ childTabs: native }), undefined)
  assert.equal(nativeChildTabs({ childTabs: native }), native)
  assert.equal(nativeChildTabs({ childTabs: url }), undefined)
  assert.equal(nativeChildTabs(undefined), undefined)
})

const src = fileURLToPath(new URL('../src/', import.meta.url))
function sources(dir = src, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, found)
    else if (/\.(ts|tsx|mts)$/.test(name)) found.push(path)
  }
  return found
}
const rel = path => relative(src, path).split('\\').join('/')

test('host protocol and PTC probes live only in src/compat/host-features.ts', () => {
  const probe = /(dshDesktop|nativeViews|childTabs|carrier|childApi|native)\??\.protocolVersion\s*[!=]==|['"]ptcRuntime['"]/
  const offenders = sources().filter(path => !rel(path).includes('__tests__/') && rel(path) !== 'compat/host-features.ts')
    .filter(path => probe.test(readFileSync(path, 'utf8'))).map(rel)
  assert.deepEqual(offenders, [])
})

/** Symbols the host packages do not export from their root, `/client` or `/types` entries. */
const DEEP_IMPORT_ALLOWLIST = new Set([
  '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-document.ts',
  '@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/runtime.ts',
  '@deepseek-ai/dsh-client-ui-conversation/src/client/input/prompt.ts',
  '@deepseek-ai/dsh-client-ui-conversation/src/client/user-text/UserText.tsx',
  '@deepseek-ai/dsh-client-ui-chat/src/client/chat/UserContent.tsx',
  '@deepseek-ai/dsh-message-quotes/src/client/quote-rule.ts',
])

test('deep @deepseek-ai/*/src imports are limited to symbols with no package export', () => {
  const deep = new Map()
  for (const path of sources()) {
    for (const [, specifier] of readFileSync(path, 'utf8').matchAll(/['"](@deepseek-ai\/[^'"]+\/src\/[^'"]+)['"]/g)) {
      if (!DEEP_IMPORT_ALLOWLIST.has(specifier)) deep.set(specifier, rel(path))
    }
  }
  assert.deepEqual([...deep], [], 'import from the package root, /client or /types instead')
  for (const path of sources().filter(path => !rel(path).includes('__tests__/'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /['"]@deepseek-ai\/[^'"]+\/src\//, `${rel(path)}: production code never deep-imports a host package`)
  }
})
