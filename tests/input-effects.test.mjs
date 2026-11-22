import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import vm from 'node:vm'
import { typescriptSourceLoader } from './typescript-source.mjs'

const loader = typescriptSourceLoader()

// Only tool-definition packaging is doubled; execute, schemas and renderers are real.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: 'data:text/javascript,export const defineTool = definition => definition', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { apply } = await import('../src/tool-browser/index.ts')
hooks.deregister()
loader.deregister()

async function mount(samples, operationError) {
  const tools = new Map(), calls = []
  let script
  const browser = {
    open: async () => 'input-session', exists: () => true,
    openUrl: async () => {},
    snapshot: async () => ({ url: 'https://example.test/', elements: [], truncated: false }),
    execute: async (session, request) => {
      assert.equal(session, 'input-session')
      script = request.script
      calls.push('fingerprint')
      const sample = samples.shift()
      if (sample instanceof Error) throw sample
      return sample
    },
  }
  for (const operation of ['click', 'type', 'key', 'scroll', 'clickSequence']) {
    browser[operation] = async session => {
      assert.equal(session, 'input-session')
      calls.push(operation)
      if (operationError) throw operationError
      return operation === 'clickSequence' ? { clicked: 2 } : undefined
    }
  }
  apply({
    get: name => name === 'browser' ? browser : undefined,
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} }, effect() {},
  }, { surface: 'tools' })
  await tools.get('dsh_browser_open').execute({ url: 'https://example.test/', surface: 'builtin' }, {})
  return { tools, calls, get script() { return script } }
}

const inputs = [
  ['click', { target: { value: '#button' } }, 'clicked', true, 'click'],
  ['type', { text: 'hello' }, 'typed', true, 'type'],
  ['key', { key: 'Enter' }, 'pressed', true, 'key'],
  ['scroll', { deltaY: 100 }, 'scrolled', true, 'scroll'],
  ['click_sequence', { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, 'clicked', 2, 'clickSequence'],
]
const ok = value => ({ ok: true, value })

for (const [name, args, flag, success, operation] of inputs) {
  test(`${name} reports changed, unchanged and unavailable fingerprints without inventing input failure`, async () => {
    for (const [before, after, verified] of [
      [ok('before'), ok('after'), true],
      [ok('same'), ok('same'), false],
      [new Error('navigating'), ok('after'), undefined],
      [ok('before'), { ok: false, error: 'unavailable' }, undefined],
      [ok(123), ok('after'), undefined],
      [ok('before'), ok(null), undefined],
    ]) {
      const h = await mount([before, after])
      const tool = h.tools.get('dsh_browser_' + name)
      const value = await tool.execute(args, {})
      assert.equal(value[flag], success)
      assert.equal(value.verified, verified)
      assert.deepEqual(h.calls, ['fingerprint', operation, 'fingerprint'])
      assert.ok(tool.output.schema.properties.verified)
      const text = tool.output.render(args, value)[0].text
      assert.doesNotMatch(text, /failed/i)
      if (verified === false) assert.match(text, /No visible change observed; the effect is uncertain/)
      if (verified === undefined) assert.match(text, /could not be checked/)
      if (verified === true) assert.match(text, /Visible change observed/)
    }
  })

  test(`${name} preserves real input errors`, async () => {
    const h = await mount([ok('before')], new Error('input refused'))
    await assert.rejects(h.tools.get('dsh_browser_' + name).execute(args, {}), /input refused/)
    assert.deepEqual(h.calls, ['fingerprint', operation])
  })
}

test('fingerprints notice ordinary input, focus and scroll changes without returning field contents', async () => {
  const h = await mount([ok('same'), ok('same')])
  await h.tools.get('dsh_browser_type').execute({ text: 'hello' }, {})
  const active = { tagName: 'INPUT', id: 'field', value: '', selectionStart: 0, selectionEnd: 0 }
  const context = { location: { href: 'https://example.test/' }, document: {
    title: 'Example', activeElement: active, body: { childElementCount: 1, innerHTML: '<input>' },
  }, window: { scrollX: 0, scrollY: 0 } }
  const original = vm.runInNewContext(h.script, context)
  active.value = 'private field contents'
  const typed = vm.runInNewContext(h.script, context)
  assert.notEqual(typed, original)
  assert.ok(!typed.includes(active.value))
  context.window.scrollY = 100
  assert.notEqual(vm.runInNewContext(h.script, context), typed)
  context.document.activeElement = null
  assert.equal(typeof vm.runInNewContext(h.script, context), 'string')
})
