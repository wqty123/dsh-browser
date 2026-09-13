import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * Regression for the "dead toolbar" bug: the toolbar page's inline <script>
 * declared its preload-API binding at GLOBAL scope with the same name the
 * preload exposes it under:
 *
 *   contextBridge.exposeInMainWorld('bridge', {...})   // preload
 *   const bridge = window.bridge                       // toolbar <script>
 *
 * `exposeInMainWorld` installs a NON-CONFIGURABLE own property on the global
 * object. A global-scope `const`/`let`/`class` with that same name is an early
 * (parse-time) SyntaxError -- HasRestrictedGlobalProperty:
 *
 *   SyntaxError: Identifier 'bridge' has already been declared
 *
 * Because it is an early error the ENTIRE script is discarded: not a single
 * statement runs. Every handler the script wires up therefore never exists --
 * the address bar ignores Enter, back/forward/reload/new-tab are dead, the tab
 * strip stays empty forever, and no error is ever surfaced to the user (the
 * error strip is wired up by that same script). The page itself keeps working,
 * so `browser_*` tools look healthy while the visible window is unusable.
 *
 * NOTE ON DETECTION: this cannot be caught by parsing the script in `node:vm`.
 * vm does not model the restriction for `const` (it does for `let`), nor does
 * it reproduce it when the name is already bound via Object.defineProperty.
 * The enforcement below therefore checks the INVARIANT directly -- top-level
 * lexical bindings must not collide with the names the preload exposes -- which
 * is exactly the rule the runtime applies.
 */

const HOST_MAIN = fileURLToPath(new URL('../lib/browser-electron/host-main.js', import.meta.url))

const source = readFileSync(HOST_MAIN, 'utf8')

/**
 * Pull the body of the first template literal assigned to `name`.
 * The toolbar HTML/preload are embedded as ``const NAME = `...` ``, and their
 * contents contain no backticks or `${` interpolation, so a plain scan to the
 * next backtick is exact.
 */
function templateLiteralAfter(name) {
  const marker = `const ${name} = \``
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${name} not found in host-main.js`)
  const bodyStart = start + marker.length
  const end = source.indexOf('`', bodyStart)
  assert.notEqual(end, -1, `unterminated ${name} template literal`)
  return source.slice(bodyStart, end)
}

/** The <script> body of the toolbar page (the last one; there is only one). */
function toolbarScript(html) {
  const open = html.lastIndexOf('<script>')
  assert.notEqual(open, -1, 'toolbar html has no <script>')
  const close = html.indexOf('</script>', open)
  assert.notEqual(close, -1, 'toolbar <script> is never closed')
  return html.slice(open + '<script>'.length, close)
}

/** Names the preload hands to contextBridge.exposeInMainWorld('name', ...). */
function exposedGlobalNames(preload) {
  const names = []
  const re = /exposeInMainWorld\(\s*(['"])(.*?)\1/g
  let m
  while ((m = re.exec(preload)) !== null) names.push(m[2])
  return names
}

/**
 * Top-level (column 0) lexical declarations in a classic script. Indented
 * declarations live inside functions/blocks and cannot hit the restriction, so
 * only unindented ones are collected.
 */
function topLevelLexicalDeclarations(script) {
  const names = []
  const re = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(script)) !== null) names.push(m[1])
  return names
}

const preload = templateLiteralAfter('TOOLBAR_PRELOAD')
const html = templateLiteralAfter('TOOLBAR_HTML')
const script = toolbarScript(html)

test('the toolbar script has no global binding that shadows a contextBridge global', () => {
  const exposed = exposedGlobalNames(preload)
  // Guard the guard: if the preload stops using contextBridge the test below
  // would pass vacuously and silently stop protecting anything.
  assert.ok(exposed.length > 0, 'no exposeInMainWorld() found in the toolbar preload')

  const declared = topLevelLexicalDeclarations(script)
  const collisions = declared.filter((n) => exposed.includes(n))

  assert.deepEqual(
    collisions,
    [],
    `toolbar script declares global ${collisions.join(', ')} which the preload already exposes via ` +
      'contextBridge (non-configurable global). That is a parse-time SyntaxError which discards the ' +
      'whole script, leaving the toolbar inert. Rename the local binding (e.g. `tb`).',
  )
})

test('the toolbar script parses as a classic script', () => {
  // Catches unrelated syntax breakage in the embedded template (an unbalanced
  // brace, a backtick that terminated the TS template literal early, ...).
  assert.doesNotThrow(() => new vm.Script(script))
})

test('the toolbar script wires up the controls the user interacts with', () => {
  // Behavioural guard: the bug's symptom was that NONE of these ran. Assert the
  // script still references each wiring point, so a future refactor cannot
  // quietly drop them.
  for (const needle of [
    "addEventListener('keydown'",
    "getElementById('back').onclick",
    "getElementById('fwd').onclick",
    "getElementById('reload').onclick",
    "getElementById('newtab').onclick",
    '.onTabs(',
    '.onError(',
  ]) {
    assert.ok(script.includes(needle), `toolbar script no longer wires up: ${needle}`)
  }
})

test('every action the toolbar posts is one the host handles', () => {
  // The toolbar is fire-and-forget: an action the host does not recognise only
  // produces a stderr line, so a typo here is invisible to the user.
  const handled = new Set()
  const re = /case\s+'([^']+)'/g
  const handleToolbarAction = source.slice(source.indexOf('function handleToolbarAction'))
  let m
  while ((m = re.exec(handleToolbarAction)) !== null) handled.add(m[1])

  const posted = new Set()
  const rePost = /\bpost\(\s*'([^']+)'/g
  while ((m = rePost.exec(script)) !== null) posted.add(m[1])

  assert.ok(posted.size > 0, 'toolbar posts no actions')
  for (const action of posted) {
    assert.ok(handled.has(action), `toolbar posts '${action}' but the host has no case for it`)
  }
})
