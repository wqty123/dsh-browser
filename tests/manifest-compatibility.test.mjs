// Where the DSH version range has to live.
//
// DSH 0.2.1-alpha.3 and later changed the rule: an own `engines.dsh` range decides ALONE and the
// `@deepseek-ai/dsh*` peerDependencies are ignored; the peer rule applies only when `engines.dsh`
// is absent. The official migration guide is
// `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/` in the DSH checkout, and the rule lives in
// `packages/boot/app-boot/src/plugin-compatibility.ts`.
//
// This plugin had the range in `dsh.compatibility.dsh`, which NO code reads — the old
// compatibility worked only because the peer fallback happened to agree. Declaring it in the place
// DSH actually reads is what makes the statement true rather than coincidental.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Every `@deepseek-ai/dsh`/`dsh-*` peer range that the fallback rule would check. */
const dshPeerRanges = () => Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  .map(([, range]) => range)

test('the DSH range is declared where DSH reads it', () => {
  assert.equal(typeof manifest.engines?.dsh, 'string',
    'engines.dsh must be a string — a non-string makes the manifest unreadable for compatibility')
  // `workspace:` is valid only in peers. In engines.dsh it declares incompatibility.
  assert.doesNotMatch(manifest.engines.dsh, /workspace:/, 'no workspace: value in engines.dsh')
  assert.ok(manifest.engines.dsh.trim() !== '', 'and it is not empty')
})

test('engines.dsh covers every release the peers claimed', () => {
  // The guide is explicit: peers no longer widen or narrow an engines.dsh range, so the range has to
  // cover everything the package supports on its own. Keeping them identical is the simplest way to
  // be sure the answer did not change when the rule did.
  const ranges = new Set(dshPeerRanges())
  assert.ok(ranges.size > 0, 'the peer fallback ranges exist')
  assert.deepEqual([...ranges], [manifest.engines.dsh],
    'engines.dsh matches the peer ranges exactly, so either rule gives the same answer')
})

test('the retired location is not presented as a decision', () => {
  // `dsh.compatibility` is still tolerated — nothing reads it — but leaving a version range in it
  // invites someone to edit that instead, and the edit would do nothing.
  const legacy = manifest.dsh?.compatibility
  assert.equal(legacy?.dsh, undefined,
    'dsh.compatibility.dsh (unread) must not carry a range; engines.dsh is the only claim')
})

test('DSH itself agrees, when the checkout is available', async () => {
  // The authoritative check. Skipped where the DSH source checkout is absent (CI), because this is
  // the one assertion that cannot be made from the plugin alone.
  const checker = 'D:/deepseek-harness/packages/boot/app-boot/lib/types/plugin-compatibility.js'
  if (!existsSync(checker)) {
    console.log('  (DSH checkout not present; skipping the authoritative check)')
    return
  }
  const { evaluatePluginCompatibility } = await import(`file:///${checker}`)

  // Supported: the version this was verified on, and the two earlier ones the docs record.
  for (const supported of ['0.2.1-rc.5', '0.2.1-rc.1', '0.2.0-rc.2', '0.1.1-rc.2']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, supported), undefined,
      `${supported} must be accepted`)
  }
  // Outside the declared range, in both directions.
  for (const unsupported of ['0.3.0', '0.1.0-rc.8']) {
    const verdict = evaluatePluginCompatibility(manifest, {}, unsupported)
    assert.notEqual(verdict, undefined, `${unsupported} must be refused`)
    assert.deepEqual(verdict.requirements, { 'engines.dsh': manifest.engines.dsh },
      'and the refusal names engines.dsh, not a peer package')
  }
})

test('the documented update path matches what DSH now refuses', () => {
  // DSH 0.2.1-alpha.2 made `installBundle` fail with `already-installed` — before pnpm runs and
  // without touching the profile — when the spec names a package the profile already depends on.
  // Its own error text says what to do: "to install another version, call remove_bundle first".
  //
  // Documenting a one-step update would send every existing user into that failure. The guide is
  // docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/; the branch is at
  // packages/boot/plugin-manager/src/index.ts (`refused('already-installed', ...)`).
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
  const guide = read('../docs/user-guide.md')
  const readme = read('../README.md')
  const readmeEn = read('../README.en.md')

  assert.match(guide, /already-installed/, 'the user guide names the failure')
  assert.match(guide, /dsh plugin --profile \S+ remove dsh-builtin-browser/, 'and gives the remove step')
  assert.match(guide, /dsh plugin --profile \S+ add dsh-builtin-browser@/, 'followed by the versioned add')
  // The add must not be presented as sufficient on its own.
  const removeAt = guide.indexOf('remove dsh-builtin-browser')
  const addAt = guide.indexOf('add dsh-builtin-browser@')
  assert.ok(removeAt !== -1 && addAt !== -1 && removeAt < addAt,
    'the guide orders removal before installation')

  assert.match(readme, /remove dsh-builtin-browser/, 'the README entry point carries the two-step note too')
  assert.match(readmeEn, /remove dsh-builtin-browser/, 'and so does the English one')
})
