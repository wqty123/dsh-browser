// Drive the registered tools for real, because nothing did.
//
// This file exists because of a specific escape. The provider computed a `selector` for every
// accessibility node, the output schema declared it, the renderer would print it, and the
// shared type carried it — and the tool still showed nothing, because the a11y execute
// rebuilds each node as an explicit allow-list of fields and that list did not include it.
//
// All 134 tests passed throughout: none of them imports lib/tool-browser and calls a tool, so
// a field dropped between the provider and the renderer was invisible to every one of them.
// These call execute() and assert on what it hands on.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'

/**
 * A context just complete enough for apply() to register its tools.
 *
 * Deliberately not a mock library: the surface is small, and writing it out makes clear what
 * the tool layer actually depends on.
 * @param services - name -> service, for `ctx.get()`.
 * @returns the fake context and the registered tools keyed by name.
 */
function makeContext(services = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section: () => undefined },
    effect: () => undefined,
    get: name => services[name],
  }
  return { ctx, tools }
}

/**
 * A browser double shaped like the provider's real result, selector included.
 * @param overrides - extra or replacement members.
 * @returns the double.
 */
function fakeBrowser(overrides = {}) {
  return {
    open: async () => 'session-1',
    session: () => 'session-1',
    exists: () => true,
    openUrl: async () => {},
    a11y: async () => ({
      url: 'https://example.com/',
      title: 'Example Domain',
      count: 1,
      truncated: false,
      nodes: [
        {
          ref: 1, role: 'button', name: 'Probe Button', value: null,
          states: ['enabled'], depth: 0, tag: 'button', x: 10, y: 20, selector: '#probe-btn',
        },
      ],
    }),
    snapshot: async () => ({
      url: 'https://example.com/',
      title: 'Example Domain',
      truncated: false,
      elements: [{ ref: 1, kind: 'button', label: 'Probe Button', selector: '#probe-btn', x: 10, y: 20 }],
    }),
    ...overrides,
  }
}

/**
 * Run one tool and return its value.
 * @param tools - the registry from makeContext.
 * @param name - the tool to run.
 * @returns whatever execute resolved to.
 */
async function run(tools, name) {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `${name} is registered`)
  return await tool.execute({}, { task: 'test' })
}

async function open(tools) {
  await tools.get('dsh_browser_open').execute(
    { url: 'https://example.com/', surface: 'builtin' }, { task: 'test' },
  )
}

test('the prompt section coexists with another browser plugin in either registration order', () => {
  for (const siblingFirst of [true, false]) {
    const { ctx, tools } = makeContext()
    const sections = new Set(siblingFirst ? ['tool:browser'] : [])
    ctx.systemPrompt.section = ({ name }) => {
      assert.equal(sections.has(name), false, 'prompt section identity is unique')
      sections.add(name)
    }
    apply(ctx, { surface: 'tools' })
    if (!siblingFirst) ctx.systemPrompt.section({ name: 'tool:browser' })
    assert.deepEqual([...sections].sort(), ['tool:browser', 'tool:browser-human-takeover', 'tool:dsh-browser-reference-presentation', 'tool:dsh-builtin-browser'])
    assert.ok(tools.has('dsh_browser_open'), 'tool registration completes')
  }
})

test('reference guidance leaves source navigation in capsules, not model-generated citations', () => {
  const { ctx, tools } = makeContext()
  const sections = []
  ctx.systemPrompt.section = section => { sections.push(section) }
  apply(ctx, { surface: 'tools' })
  const guidance = sections.find(section => section.name === 'tool:dsh-browser-reference-presentation')
  assert.match(guidance.text, /Do not repeat.*source\/citation links/u)
  const capture = tools.get('dsh_browser_reference_capture')
  const list = tools.get('dsh_browser_reference_list')
  assert.match(capture.description, /Do not repeat reference URIs/u)
  assert.match(list.description, /do not repeat reference URIs/u)
  const reference = { referenceId: 'ref-1', title: 'Test', pageUrl: 'https://example.com/', capturedAt: 'now', parts: [], failures: [] }
  const captured = capture.output.render({}, { ...reference, ok: true })[0].text
  const listed = list.output.render({}, { references: [reference] })[0].text
  assert.match(captured, /Do not repeat.*source\/citation link/u)
  assert.match(listed, /not a reply link/u)
  for (const text of [captured, listed]) assert.doesNotMatch(text, /Cite it|dsh-browser-ref:ref-1|\]\(/u)
  assert.match(capture.output.render({}, { ok: false, failures: [{ kind: 'text', reason: 'empty-text' }] })[0].text, /Nothing was captured/u)
  assert.match(list.output.render({}, { references: [] })[0].text, /No browser references/u)
})

test('dsh_browser_a11y hands the selector on', async () => {
  const { ctx, tools } = makeContext({ browser: fakeBrowser() })
  apply(ctx, { surface: 'tools' })
  await open(tools)

  const value = await run(tools, 'dsh_browser_a11y')

  assert.equal(value.nodes.length, 1, 'one node came back')
  assert.equal(
    value.nodes[0].selector,
    '#probe-btn',
    `the a11y mapping must carry selector; it carries: ${Object.keys(value.nodes[0]).join(', ')}`,
  )
})

test('dsh_browser_snapshot hands the selector on', async () => {
  const { ctx, tools } = makeContext({ browser: fakeBrowser() })
  apply(ctx, { surface: 'tools' })
  await open(tools)

  const value = await run(tools, 'dsh_browser_snapshot')
  assert.equal(value.elements[0].selector, '#probe-btn', 'the snapshot mapping carries selector')
})

test('both element mappings carry the same field set', async () => {
  // The two mappings reimplement the same idea, and they disagreed: one listed selector, the
  // other did not. Comparing them catches the next field that only lands in one of them.
  const { ctx, tools } = makeContext({ browser: fakeBrowser() })
  apply(ctx, { surface: 'tools' })
  await open(tools)

  const a11y = await run(tools, 'dsh_browser_a11y')
  const snapshot = await run(tools, 'dsh_browser_snapshot')

  const a11yKeys = Object.keys(a11y.nodes[0]).sort()
  const snapshotKeys = Object.keys(snapshot.elements[0]).sort()

  // They are different shapes by design (role/name vs kind/label), so compare only the fields
  // that exist on both sides as concepts the caller can target with.
  for (const shared of ['ref', 'x', 'y', 'selector']) {
    assert.ok(a11yKeys.includes(shared), `a11y nodes carry ${shared} (got: ${a11yKeys.join(', ')})`)
    assert.ok(snapshotKeys.includes(shared), `snapshot elements carry ${shared} (got: ${snapshotKeys.join(', ')})`)
  }
})

test('a required field in the output schema is one the tool can actually produce', async () => {
  // The escape this guards against: a schema promising a property the execute never copies.
  // Invisible to the type checker (the mapping is an object literal) and to the suite (nothing
  // ran a tool). Optional fields are exempt, since those may legitimately be absent.
  const { ctx, tools } = makeContext({ browser: fakeBrowser() })
  apply(ctx, { surface: 'tools' })
  await open(tools)

  const problems = []
  for (const name of ['dsh_browser_a11y', 'dsh_browser_snapshot']) {
    const tool = tools.get(name)
    const properties = tool?.output?.schema?.properties ?? {}
    const value = await run(tools, name)
    for (const [key, spec] of Object.entries(properties)) {
      if (spec?.required !== true) continue
      if (!(key in value)) problems.push(`${name}: schema requires "${key}" but the result omits it`)
    }
  }
  assert.deepEqual(problems, [], problems.join('; '))
})
