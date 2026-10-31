// The `dsh_browser_*` namespace, and the collision that produced it.
//
// A sibling plugin (Tencent BrowserSkill) registered six tools under the bare `browser_*` name,
// and its first spec was `browser_session` — the name this plugin already held globally. The host
// refuses a duplicate name outright, so that one collision took all six of its tools down with it,
// behind a `console.warn` a desktop user never sees. The user-visible symptom was "the plugin does
// nothing", which is why it took hours to place.
//
// Two properties are locked in here: this plugin now names its tools under a namespace only it
// claims, and losing a name can never again cost the whole toolset.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = () => readFileSync(new URL('../src/tool-browser/index.ts', import.meta.url), 'utf8')
const readSrc = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('every registered tool is in the dsh_browser_ namespace, and nothing else is', () => {
  // `[a-z0-9_]`, not `[a-z_]`: `dsh_browser_a11y` contains digits, and the narrower class silently
  // matched it as `dsh_browser_a` — which made this assertion count 33 tools where there are 34,
  // and left the very name it was written to protect only half-checked.
  const names = [...source().matchAll(/name: '(dsh_browser_[a-z0-9_]+)'/g)].map(m => m[1])

  assert.equal(names.length, 35, 'thirty-five tools')
  assert.equal(new Set(names).size, names.length, 'names are unique')
  assert.ok(names.includes('dsh_browser_open'))
  assert.ok(names.includes('dsh_browser_session'), 'including the one that used to collide')
  assert.ok(names.includes('dsh_browser_a11y'), 'and the one with digits in it')
  assert.ok(names.includes('dsh_browser_click_sequence'), 'and the batch-input tool added for canvas pages')

  // No bare name survives: a single `browser_open` left behind would be the old collision waiting
  // to happen all over again, and it would fail silently because the other 33 still load.
  const bare = [...source().matchAll(/name: '(?!dsh_browser_)(browser_[a-z0-9_]+)'/g)].map(m => m[1])
  assert.deepEqual(bare, [], 'no tool may be registered under the bare namespace')
})

test('one lost name cannot take the other thirty-two with it', () => {
  const text = source()
  // Every call site goes through the wrapper. A single direct `ctx.tools.register(defineTool(`
  // would reintroduce the exact failure — that call throws on a duplicate, and the throw aborts
  // the rest of the apply.
  const direct = [...text.matchAll(/ctx\.tools\.register\(defineTool\(/g)].length
  assert.equal(direct, 0, 'no call site registers directly')
  assert.match(text, /const registerSafely = \(definition: ReturnType<typeof defineTool>\): void => \{/,
    'the wrapper exists')
  assert.match(text, /ctx\.tools\.register\(definition\)/, 'and still does the registration itself')
})

test('a collision warns with the name and the reason, and does not throw', () => {
  const text = source()
  // The wrapper must catch, not rethrow: rethrowing inside a loop is how the sibling plugin lost
  // everything, and every tool here is registered in sequence.
  assert.match(text, /} catch \(error\) \{[\s\S]{0,400}ctx\.logger\?\.warn\?\.\(/, 'caught and reported')
  assert.match(text, /could not register \$\{definition\.name\}/, 'the message names the tool')
  assert.match(text, /browser tool names are a shared namespace/, 'and explains why it can happen')
  assert.match(text, /rest of this plugin\\'s tools are unaffected/, 'and says the damage is bounded')
})

test('the rename did not touch uppercase constants', () => {
  // The first attempt at this rename was case-insensitive and rewrote BROWSER_PROFILE_DIR and
  // every error code, which broke `code === 'BROWSER_...'` comparisons and left an undefined
  // identifier. Tool names are entirely lowercase, so a capital after the prefix can only be
  // collateral damage — checked on the real sources, not on the rename script.
  for (const file of ['tool-browser/index.ts', 'browser-electron/provider.ts', 'browser-electron/entry.ts']) {
    const text = readSrc(file)
    const smashed = [...text.matchAll(/dsh_browser_[A-Z][A-Z_0-9]*/g)].map(m => m[0])
    assert.deepEqual(smashed, [], `${file} has a constant that the rename damaged`)
  }
  assert.match(readSrc('browser-electron/entry.ts'), /BROWSER_PROFILE_DIR/, 'the constant is intact')
  assert.match(readSrc('browser-electron/provider.ts'), /BROWSER_SNAPSHOT_TIMEOUT/, 'and so is this one')
})
