import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../tools/install-web-plugin.mjs', import.meta.url))

function fixture(t, profile = 'web') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const harness = join(root, 'harness')
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  mkdirSync(harness, { recursive: true })
  const file = join(dir, 'package.json')
  const body = JSON.stringify({ dependencies: { 'dsh-builtin-browser': '0.4.15' } }, null, 2) + '\n'
  writeFileSync(file, body)
  const env = { ...process.env, DSH_HOME: home, DSH_HARNESS: harness, DSH_PROFILE: 'web', DSH_REPAIR_TOOL: join(root, 'absent-repair.mjs'), DSH_DESKTOP_APP: join(root, 'absent-desktop'), LOCALAPPDATA: join(root, 'local') }
  const run = args => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
  return { file, dir, body, run, env }
}

for (const args of [['--profile', 'web'], ['--profile', 'web', '0.4.16'], ['0.4.16', '--profile', 'web']]) {
  test(`missing repair prerequisite leaves pin and backups untouched: ${args.join(' ')}`, t => {
    const { file, dir, body, run } = fixture(t)
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no repair tool found/)
    assert.equal(readFileSync(file, 'utf8'), body)
    assert.deepEqual(readdirSync(dir), ['package.json'])
    if (args.length === 2) assert.doesNotMatch(result.stdout, /pinned web/)
  })
}

test('a profile option before the version is consumed as an option value', t => {
  const { file, run, env } = fixture(t)
  writeFileSync(env.DSH_REPAIR_TOOL, '// test prerequisite; the link refusal must occur before commands run\n')
  const body = JSON.stringify({ dependencies: { 'dsh-builtin-browser': 'link:../local-checkout' } }) + '\n'
  writeFileSync(file, body)
  const result = run(['--profile', 'web', '0.4.16'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refusing to overwrite a link: pin with 0\.4\.16/)
  assert.equal(readFileSync(file, 'utf8'), body)
})

test('missing desktop peers are checked before changing the requested version', t => {
  const { file, body, run } = fixture(t, 'desktop')
  const result = run(['0.4.16', '--profile', 'desktop'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /could not find the desktop/)
  assert.equal(readFileSync(file, 'utf8'), body)
})

for (const args of [['--profile'], ['--profile', '--verify'], ['--unknown'], ['0.4.16', '0.4.17']]) {
  test(`invalid arguments fail without changing the profile: ${args.join(' ')}`, t => {
    const { file, body, run } = fixture(t)
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /argument|--profile|unknown|version/i)
    assert.equal(readFileSync(file, 'utf8'), body)
  })
}
