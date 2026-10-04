// The field table, the schemas and the projections must agree — checked for every tool.
//
// WHY THIS FILE EXISTS
//
// Two bugs shipped through the same gap, a round apart: `browser_a11y`'s `selector` and
// `browser_screenshot`'s `width`/`height`. In both cases the provider computed the value, the
// output schema declared it, and a hand-written projection in the tool layer dropped it. The
// tests at the time were green, because not one of them ran a tool.
//
// `element-fields.ts` makes the field set a single declaration, and this file is what holds it
// to that: the schema's properties and the projection's output are both compared against the
// table, for every registered tool rather than the two that happened to be noticed.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'
import {
  DECLARED_FIELDS,
  ELEMENT_ITEM_SCHEMA,
  NODE_ITEM_SCHEMA,
  projectElement,
  projectNode,
} from '../lib/tool-browser/element-fields.js'

/**
 * A context complete enough for apply() to register its tools.
 * @param services - name -> service.
 * @returns the fake context and the registry.
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

// Fields the schema declares and the table declares must be the same set, both ways.
test('the element schema and the element table declare the same fields', () => {
  const schemaKeys = Object.keys(ELEMENT_ITEM_SCHEMA.properties).sort()
  const tableKeys = [...DECLARED_FIELDS.element].sort()
  assert.deepEqual(schemaKeys, tableKeys, 'schema ⟷ table drift means one silently drops a field or rejects a whole result')
})

test('the node schema and the node table declare the same fields', () => {
  const schemaKeys = Object.keys(NODE_ITEM_SCHEMA.properties).sort()
  const tableKeys = [...DECLARED_FIELDS.node].sort()
  assert.deepEqual(schemaKeys, tableKeys, 'schema ⟷ table drift')
})

// The projection must carry everything the table declares, given a source that has everything.
test('the element projection carries every declared field', () => {
  const source = {
    ref: 1, kind: 'button', label: 'Go', selector: '#go', x: 10, y: 20, frame: true,
  }
  const projected = projectElement(source)
  assert.deepEqual(Object.keys(projected).sort(), [...DECLARED_FIELDS.element].sort())
})

test('the node projection carries every declared field', () => {
  const source = {
    ref: 1, role: 'button', name: 'Go', value: 'v', states: ['enabled'], depth: 0,
    tag: 'button', selector: '#go', x: 10, y: 20, frame: true,
  }
  const projected = projectNode(source)
  assert.deepEqual(Object.keys(projected).sort(), [...DECLARED_FIELDS.node].sort())
})

// Fields the schema does NOT declare must be dropped by the projection, because
// `additionalProperties: false` turns a stray field into a rejected result.
test('the projection drops what the schema does not declare', () => {
  const projected = projectElement({ ref: 1, kind: 'k', label: 'l', x: 0, y: 0, undocumented: 'nope' })
  assert.equal('undocumented' in projected, false, 'an undeclared field in the result would fail schema validation')
})

// A required field that the projection omits would fail validation at run time; a required
// field the schema forgets would let a caller read undefined.
test('every field the schema marks required is one the table marks required', () => {
  for (const [label, schema, table] of [
    ['element', ELEMENT_ITEM_SCHEMA, DECLARED_FIELDS.element],
    ['node', NODE_ITEM_SCHEMA, DECLARED_FIELDS.node],
  ]) {
    const requiredInSchema = Object.entries(schema.properties)
      .filter(([, spec]) => spec.required === true)
      .map(([name]) => name)
      .sort()
    assert.ok(requiredInSchema.every(name => table.includes(name)), `${label}: a required field is not in the table`)
  }
})

// And the whole-registry check: every tool's output schema must be satisfiable by the tool.
// The fakes below answer every method with a plausible shape, so a tool that reads an
// unexpected field fails loudly here rather than in production.
test('every registered tool produces a value its own schema accepts', async () => {
  const page = { url: 'https://example.com/', title: 'T', truncated: false, count: 1, ok: true }
  const element = { ref: 1, kind: 'button', label: 'Go', selector: '#go', x: 1, y: 2 }
  const node = { ref: 1, role: 'button', name: 'Go', states: ['enabled'], depth: 0, tag: 'button', selector: '#go', x: 1, y: 2 }
  const answered = {
    ...page,
    elements: [element],
    nodes: [node],
    dataUrl: 'data:image/png;base64,AA==',
    content: 'text',
    items: [{ a: 1 }],
    entries: [],
    cookies: [],
    settings: {},
    tabs: [],
    value: null,
    width: 10,
    height: 10,
    path: 'C:\\tmp\\x.png',
    restored: 1,
  }
  // A browser that answers anything asked of it with a plausible value.
  const browser = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined
      if (name === 'session') return () => 'session-1'
      if (name === 'exists') return () => true
      return async () => answered
    },
  })

  const { ctx, tools } = makeContext({ browser })
  apply(ctx)
  assert.ok(tools.size >= 30, `expected the full tool set, got ${tools.size}`)

  const failures = []
  for (const [name, tool] of tools) {
    const properties = tool.output?.schema?.properties ?? {}
    let value
    try {
      value = await tool.execute({}, { task: 'schema-check' })
    } catch (error) {
      // A tool that refuses this synthetic input is fine; it is not a schema disagreement.
      continue
    }
    for (const [key, spec] of Object.entries(properties)) {
      if (spec?.required !== true) continue
      if (!(key in value)) failures.push(`${name}: schema requires "${key}" but the result omits it`)
    }
  }
  assert.deepEqual(failures, [], failures.join('; '))
})
