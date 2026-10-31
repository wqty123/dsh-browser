import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SettingsStore } from '../lib/browser-electron/settings-store.js'

function fixture(t, body = '{}') {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-settings-gates-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'settings.json')
  fs.writeFileSync(file, body)
  return file
}

function assertRefused(settings) {
  assert.equal(settings.credentials.allowRead, false)
  assert.deepEqual(settings.actions, { allowExecute: false, allowDownload: false, allowCredentialWrite: false })
}

test('valid JSON with a non-object top level refuses capability gates', t => {
  for (const raw of [null, false, 42, 'invalid document', []]) {
    const file = fixture(t, JSON.stringify(raw))
    assertRefused(new SettingsStore(file).get())
  }
})

for (const code of ['EACCES', 'EIO']) {
  test(`a ${code} stat failure refuses gates on first read and after a cached read`, t => {
    const file = fixture(t)
    const cached = new SettingsStore(file)
    assert.equal(cached.get().actions.allowExecute, true)
    const realStat = fs.statSync
    const stat = mock.method(fs, 'statSync', (target, ...rest) => {
      if (target === file) throw Object.assign(new Error('injected stat failure'), { code })
      return realStat(target, ...rest)
    })
    syncBuiltinESMExports()
    try {
      assertRefused(new SettingsStore(file).get())
      assertRefused(cached.get())
    } finally {
      stat.mock.restore()
      syncBuiltinESMExports()
    }
  })
}
