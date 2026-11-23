// Every label the settings panel renders must exist in BOTH locales.
//
// A missing key does not fail loudly: the panel renders the key itself ("actions.allowExecute")
// and every test stays green, which is how three dead settings shipped before. This walks the
// bundle's own calls and checks them against both locale tables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundledModule } from './helpers/client-build.mjs'

// Both halves come from the shipped bundle: the locale tables as inlined there, and the panel's own
// compiled code, so a label the bundler dropped or renamed is caught too.
const locales = bundledModule('assets/browser-panel-locales.mjs')
const source = bundledModule('src/client/settings/panel.ts')

const EN_START = locales.search(/const en(?:\$\d+)? = \{/)
assert.ok(/const zh(?:\$\d+)? = \{/.test(locales) && EN_START !== -1, 'both locale tables are present')

const zhBlock = locales.slice(0, EN_START)
const enBlock = locales.slice(EN_START)

/**
 * The keys a locale table declares.
 *
 * Values are string literals or a shared message (`extensionMessages.zh.connected`).
 * Both spellings matter: dotted keys are written quoted (`"history.title":`) while the
 * single-word ones are bare (`nav: "Browser"`). Matching only the quoted form silently
 * missed seven labels — including `lead` and `saved`, which the panel does render — and
 * would have made the "same keys in both languages" check pass on two tables that had
 * been read wrong in the same way.
 */
function declaredKeys(block) {
  const keys = new Set()
  for (const match of block.matchAll(/^\s*(?:"([A-Za-z][\w.]*)"|([A-Za-z]\w*)):\s*(?:"|[A-Za-z_$])/gm)) {
    keys.add(match[1] ?? match[2])
  }
  return keys
}

/**
 * The keys the panel asks for: `t("…")`, the `*Key:` props handed to Toggle, and the
 * first argument of `section(...)`. Dynamic lookups (`t(props.labelKey)`) carry no
 * literal and are covered through the props they are given.
 */
function renderedKeys() {
  const keys = new Set()
  const patterns = [
    /\bt\("([^"]+)"\)/g,
    /\b(?:labelKey|hintKey|titleKey): "([^"]+)"/g,
    /\bsection\("([^"]+)"/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) keys.add(match[1])
  }
  return keys
}

test('the panel renders a real set of labels', () => {
  // Guards the extractor itself: a regex that stopped matching would otherwise make every
  // assertion below vacuously true.
  const rendered = renderedKeys()
  assert.ok(rendered.size > 20, `the extractor finds the panel's labels (found ${rendered.size})`)
  assert.ok(rendered.has('settings.advanced'), 'including the advanced settings label')
})

test('every label the panel renders exists in both locales', () => {
  const zh = declaredKeys(zhBlock)
  const en = declaredKeys(enBlock)
  const missing = []
  for (const key of renderedKeys()) {
    if (!zh.has(key)) missing.push(`zh:${key}`)
    if (!en.has(key)) missing.push(`en:${key}`)
  }
  assert.deepEqual(missing, [], 'the panel would render these keys instead of a label')
})

test('the two locales declare exactly the same keys', () => {
  const zh = [...declaredKeys(zhBlock)].sort()
  const en = [...declaredKeys(enBlock)].sort()
  assert.deepEqual(en, zh, 'a key present in one language only is a label missing for half the users')
})
