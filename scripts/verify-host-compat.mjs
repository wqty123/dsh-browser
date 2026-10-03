#!/usr/bin/env node
/**
 * Host-compatibility probe: does THIS build of the plugin run on the DSH in front of it?
 *
 * A version range in package.json is a claim, not evidence. This assembles a host out of the
 * real DSH packages installed in a profile, loads the plugin's compiled output, registers its
 * tools through the host's own `defineTool`, and calls two of them over the plugin's provider
 * seam. It is the check that answers "did DSH 0.2.x break us?" without booting a browser.
 *
 * Usage:
 *   node scripts/verify-host-compat.mjs                 # probe the profile named by DSH_PROFILE
 *   DSH_PROFILE=desktop node scripts/verify-host-compat.mjs
 *   DSH_HOME=/path/to/.dsh node scripts/verify-host-compat.mjs
 *
 * Resolution: the profile's own package.json is the module root, so `@deepseek-ai/*` resolves
 * exactly as it does at runtime (links included). With no usable profile the probe reports
 * that it could not run and exits 0 — an unprobeable host is not a compatibility failure, and
 * making CI red for it would be reporting the wrong thing.
 *
 * What it does NOT cover: the browser actually launching (no Electron here), and the client
 * panel rendering in a real session.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = new URL('..', import.meta.url)
const failures = []

const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
  if (!condition) failures.push(label)
}

/** The profile whose node_modules resolve the host packages, or undefined. */
function findProfileRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return undefined
  const named = process.env.DSH_PROFILE
  const candidates = named !== undefined && named !== ''
    ? [named]
    : readdirSync(profiles).filter(entry => existsSync(join(profiles, entry, 'package.json')))
  for (const candidate of candidates) {
    const manifest = join(profiles, candidate, 'package.json')
    if (existsSync(manifest)) return { name: candidate, manifest }
  }
  return undefined
}

const profile = findProfileRoot()
if (profile === undefined) {
  console.log('No DSH profile found (looked under $DSH_HOME/profiles).')
  console.log('Set DSH_HOME or DSH_PROFILE to point at one; nothing to verify.')
  process.exit(0)
}

const require = createRequire(profile.manifest)
const load = async (spec) => import(pathToFileURL(require.resolve(spec)).href)

console.log(`Host: profile "${profile.name}" at ${profile.manifest}`)
let hostVersion = 'unknown'
try {
  hostVersion = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-system-prompt/package.json'), 'utf8')).version
} catch { /* reported as unknown; the probe below is what matters */ }
console.log(`      @deepseek-ai/dsh-system-prompt = ${hostVersion}`)
console.log('')

console.log('=== 1. the host API surface this plugin imports ===')
let cordis
let dshTools
let dshLlm
let schemastery
try {
  cordis = await load('@deepseek-ai/cordis')
  dshTools = await load('@deepseek-ai/dsh-tools')
  dshLlm = await load('@deepseek-ai/dsh-llm')
  schemastery = await load('@deepseek-ai/schemastery')
} catch (error) {
  console.log(`  FAIL  a host package could not be resolved: ${String(error && error.message)}`)
  process.exit(1)
}
const z = schemastery.default ?? schemastery

ok('@deepseek-ai/cordis exports Context', typeof cordis.Context === 'function')
ok('@deepseek-ai/cordis exports Service', typeof cordis.Service === 'function')
ok('@deepseek-ai/dsh-tools exports defineTool', typeof dshTools.defineTool === 'function')
ok('@deepseek-ai/dsh-llm exports HarnessError', typeof dshLlm.HarnessError === 'function')
ok('@deepseek-ai/schemastery default is the schema builder', typeof z?.string === 'function')

console.log('')
console.log('=== 2. the plugin loads against a real cordis context ===')
const root = new cordis.Context()

// Stub services. DSH's own tools/systemPrompt implementations are not what is under test and
// standing them up would mean booting a profile; only their SHAPE matters here, and it is
// taken from the real ones: `ctx.tools.register(definition)`, `ctx.systemPrompt.section(spec)`.
const registered = new Map()
class StubTools extends cordis.Service {
  constructor(ctx) { super(ctx, 'tools') }
  register(definition) { registered.set(definition.name, definition); return () => {} }
}
class StubSystemPrompt extends cordis.Service {
  constructor(ctx) { super(ctx, 'systemPrompt'); this.sections = [] }
  section(spec) { this.sections.push(spec); return () => {} }
}
new StubTools(root)
const prompts = new StubSystemPrompt(root)

try {
  const runtimeModule = await import(new URL('lib/browser/runtime.js', REPO).href)
  ok('the plugin ships a browser seam service', typeof runtimeModule.default === 'function')
  new runtimeModule.default(root)
  ok('the seam registered itself as ctx.browser', root.get('browser') !== undefined)

  const layer = await import(new URL('lib/tool-browser/index.js', REPO).href)
  ok('the tool layer exports an apply()', typeof layer.apply === 'function')
  layer.apply(root, {})
  ok('tools registered through the host\'s own defineTool', registered.size > 30, `${registered.size} tools`)
  ok('the system prompt section was declared', prompts.sections.length === 1)
} catch (error) {
  ok('the plugin loads and registers', false, String(error && error.stack).split('\n').slice(0, 2).join(' | '))
}

console.log('')
console.log('=== 3. the definitions the host will consume ===')
// `defineTool` already accepted every spec the plugin handed it — it throws on a shape it
// cannot compile, and the tools came back — so what is left is the stored definition: a JSON
// Schema the host can show a model, plus the output contract.
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])
const schemaFailures = []
for (const [name, definition] of registered) {
  if (typeof definition.execute !== 'function') schemaFailures.push(`${name}: no execute`)
  if (definition.output?.schema === undefined) schemaFailures.push(`${name}: no output.schema`)
  if (typeof definition.output?.render !== 'function') schemaFailures.push(`${name}: no output.render`)
  if (typeof definition.description !== 'string' || definition.description === '') schemaFailures.push(`${name}: no description`)
  const parameters = definition.parameters
  if (typeof parameters !== 'object' || parameters === null) {
    schemaFailures.push(`${name}: parameters is not a schema object`)
    continue
  }
  if (parameters.type !== 'object') schemaFailures.push(`${name}: parameters.type is ${String(parameters.type)}`)
  for (const [field, spec] of Object.entries(parameters.properties ?? {})) {
    if (typeof spec?.type !== 'string' || !SCALAR_TYPES.has(spec.type)) schemaFailures.push(`${name}.${field}: type ${String(spec?.type)}`)
  }
}
ok('every tool definition carries a usable schema', schemaFailures.length === 0, schemaFailures.slice(0, 4).join(' | '))

console.log('')
console.log('=== 4. a tool runs, over the plugin\'s own provider seam ===')
const fakeSession = 'browser:00000000-0000-4000-8000-000000000001'
try {
  root.get('browser').registerBrowserProvider({
    id: 'verify-host-compat',
    available: () => true,
    open: async () => fakeSession,
    listTabs: async () => [{ id: 'tab:1', title: 'verify', url: 'about:blank', active: true }],
    a11y: async () => ({
      url: 'about:blank',
      count: 1,
      truncated: false,
      nodes: [{ ref: 1, role: 'button', name: 'Probe', states: ['enabled'], depth: 0, tag: 'button', selector: '#probe', x: 1, y: 2 }],
    }),
  })
} catch (error) {
  ok('a provider can register on the seam', false, String(error && error.message))
}

const exec = { agent: { id: 'verify-host-compat' } }
try {
  const value = await registered.get('browser_session').execute({}, exec)
  ok('browser_session ran', value !== undefined, JSON.stringify(value).slice(0, 100))
} catch (error) {
  ok('browser_session ran', false, String(error && error.message))
}

try {
  const tool = registered.get('browser_a11y')
  const value = await tool.execute({}, exec)
  const text = JSON.stringify(tool.output.render({}, value))
  ok('browser_a11y ran and rendered', value?.nodes?.length === 1, '')
  ok('its renderer emits the element selector', text.includes('#probe'), text.slice(0, 120))
} catch (error) {
  ok('browser_a11y ran', false, String(error && error.message))
}

console.log('')
if (failures.length === 0) {
  console.log(`VERDICT: this build runs on the host above (${hostVersion}).`)
} else {
  console.log(`VERDICT: ${failures.length} failure(s) — this build does NOT match the host above:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
