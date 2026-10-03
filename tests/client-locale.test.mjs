// Every label the settings panel renders must exist in BOTH locales.
//
// A missing key does not fail loudly: the panel renders the key itself ("actions.allowExecute")
// and every test stays green, which is how three dead settings shipped before. This walks the
// bundle's own calls and checks them against both locale tables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const ZH_START = source.indexOf('const zh = {')
const EN_START = source.indexOf('const en = {')
// The English table ends where the panel's own code begins. Slicing to the end of the file
// instead pulled that code in, and its own `key: "…"` lines read as locale keys.
const EN_END = source.indexOf('/** Read or patch the host-owned settings document.')
assert.ok(ZH_START !== -1 && EN_START !== -1 && EN_END !== -1 && EN_START > ZH_START, 'both locale tables are present')

const zhBlock = source.slice(ZH_START, EN_START)
const enBlock = source.slice(EN_START, EN_END)

/**
 * The keys a locale table declares.
 *
 * Both spellings matter: dotted keys are written quoted (`"history.title":`) while the
 * single-word ones are bare (`nav: "Browser"`). Matching only the quoted form silently
 * missed seven labels — including `lead` and `saved`, which the panel does render — and
 * would have made the "same keys in both languages" check pass on two tables that had
 * been read wrong in the same way.
 */
function declaredKeys(block) {
  const keys = new Set()
  for (const match of block.matchAll(/^\s*(?:"([A-Za-z][\w.]*)"|([A-Za-z]\w*)):\s*"/gm)) {
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
  assert.ok(rendered.has('actions.allowExecute'), 'including the ones this change added')
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
