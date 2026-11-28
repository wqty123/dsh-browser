// Carrier and maintenance budgets live in one place, so a value cannot drift between modules.
//
// The same 30 s appeared in four modules as a bare literal (bridge calls, CDP commands, bridge
// install, profile commands), which is how one of them silently keeps the old budget after the
// policy changes. These checks keep the four sites importing the named budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const policy = readFileSync(join(ROOT, 'assets/browser-policy.mjs'), 'utf8')

/** Modules that must not own a bare carrier/maintenance timeout of their own. */
const OWNERS = {
  'src/browser-electron/desktop-bridge-host.ts': ['CARRIER_PROBE_TIMEOUT_MS', 'CARRIER_CALL_TIMEOUT_MS', 'CARRIER_DOWNLOAD_TIMEOUT_MS'],
  'src/browser-electron/system-browser.ts': ['CARRIER_CALL_TIMEOUT_MS'],
  'src/browser-electron/bridge-install.ts': ['MAINTENANCE_PROCESS_TIMEOUT_MS'],
  'src/browser-electron/profile-command.ts': ['PROFILE_COMMAND_TIMEOUT_MS'],
  'src/browser-electron/automatic-maintenance.ts': ['MAINTENANCE_QUIT_WAIT_MS'],
}

test('the policy declares the carrier and maintenance budgets', () => {
  for (const name of new Set(Object.values(OWNERS).flat())) {
    assert.match(policy, new RegExp(`export const ${name} = \\d[\\d_]*`, 'u'), `${name} is exported by the policy`)
  }
})

test('carrier modules import their budget instead of restating the number', () => {
  for (const [file, names] of Object.entries(OWNERS)) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const name of names) assert.ok(source.includes(name), `${file} uses ${name}`)
    assert.doesNotMatch(source, /\b(?:5_000|30_000|60_000)\b/u, `${file} has no bare carrier budget left`)
  }
})

test('the budget values keep their meaning', () => {
  // Cheap probe < one call <= one download. A change that breaks this ordering is a policy edit,
  // not a refactor, and has to show up here.
  const value = name => Number(new RegExp(`export const ${name} = ([\\d_]+)`, 'u').exec(policy)[1].replaceAll('_', ''))
  assert.ok(value('CARRIER_PROBE_TIMEOUT_MS') < value('CARRIER_CALL_TIMEOUT_MS'))
  assert.ok(value('CARRIER_CALL_TIMEOUT_MS') <= value('CARRIER_DOWNLOAD_TIMEOUT_MS'))
  assert.ok(value('MAINTENANCE_PROCESS_TIMEOUT_MS') <= value('MAINTENANCE_QUIT_WAIT_MS'))
})
