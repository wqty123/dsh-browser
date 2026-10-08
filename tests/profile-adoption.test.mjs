// Adopting the browser profile an older layout left behind.
//
// The profile is where the login state lives, so a path change that abandons it signs the user out
// of everything at once. That was reported after the path fix shipped, as a one-time cost of the
// fix — and a one-time cost that does not have to be paid. These tests pin the move's two rules:
// it happens when there is something to move, and it never overwrites a profile that is already
// there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptLegacyProfileRoot } from '../lib/browser-electron/entry.js'

/** A directory tree with a marker file inside the legacy root. */
function scene({ legacy = true, current = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'profile-adopt-'))
  const legacyRoot = join(base, 'home', 'dsh-builtin-browser-host')
  const profileRoot = join(base, 'home', '.dsh', 'dsh-builtin-browser-host')
  if (legacy) {
    mkdirSync(join(legacyRoot, 'edge-profile'), { recursive: true })
    writeFileSync(join(legacyRoot, 'edge-profile', 'Cookies'), 'signed in')
  }
  if (current) {
    mkdirSync(join(profileRoot, 'edge-profile'), { recursive: true })
    writeFileSync(join(profileRoot, 'edge-profile', 'Cookies'), 'current')
  }
  return { legacyRoot, profileRoot }
}

test('a profile left in the old layout is moved into the current one', () => {
  const { legacyRoot, profileRoot } = scene()

  adoptLegacyProfileRoot(profileRoot, legacyRoot)

  assert.ok(existsSync(join(profileRoot, 'edge-profile', 'Cookies')),
    'the login state survives the move')
  assert.equal(existsSync(legacyRoot), false, 'and the old root is gone rather than duplicated')
})

test('a profile that is already there is never overwritten', () => {
  const { legacyRoot, profileRoot } = scene({ legacy: true, current: true })

  adoptLegacyProfileRoot(profileRoot, legacyRoot)

  assert.equal(
    readFileSync(join(profileRoot, 'edge-profile', 'Cookies'), 'utf8'),
    'current',
    'the profile in use wins',
  )
  assert.ok(existsSync(legacyRoot), 'and the stale one is left where it is, intact')
})

test('nothing to adopt is a no-op, and never a throw', () => {
  const { legacyRoot, profileRoot } = scene({ legacy: false })

  assert.doesNotThrow(() => adoptLegacyProfileRoot(profileRoot, legacyRoot))
  assert.equal(existsSync(profileRoot), false, 'no directory is invented')
})

test('the same path on both sides is left alone', () => {
  const { profileRoot } = scene()
  assert.doesNotThrow(() => adoptLegacyProfileRoot(profileRoot, profileRoot))
})
