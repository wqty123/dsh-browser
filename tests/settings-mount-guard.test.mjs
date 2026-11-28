// The settings section must mount once per page: a hot re-apply is a no-op, a failed mount retries
// (issue #132).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimSettingsMount, markSettingsMounted, SETTINGS_MOUNTED_KEY } from '../src/client/settings/mount-guard.ts'

test('a page claims the settings mount once, and marks it only after success', () => {
  const scope = {}
  assert.equal(claimSettingsMount(scope), true, 'the first apply mounts')
  assert.equal(claimSettingsMount(scope), true, 'a claim alone does not count as mounted')
  markSettingsMounted(scope)
  assert.equal(scope[SETTINGS_MOUNTED_KEY], true)
  assert.equal(claimSettingsMount(scope), false, 'a repeated apply on the same page is a no-op')
})

test('a fresh page starts unclaimed', () => {
  const first = {}
  markSettingsMounted(first)
  assert.equal(claimSettingsMount({}), true, 'the claim is per page, never shared across pages')
})