import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { windowsPowerShellPath } from '../lib/browser-electron/windows-system.js'

const helper = fileURLToPath(new URL('../desktop-bridge/maintenance-progress.ps1', import.meta.url))
const windows = { skip: process.platform !== 'win32' }

test('the independent progress script parses under Windows PowerShell without executing UI code', windows, () => {
  const encodedPath = Buffer.from(helper, 'utf8').toString('base64')
  const code = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count -gt 0){$errors|ForEach-Object{$_.Message};exit 1}`
  const result = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('the real progress window refuses test contexts before accessing state or opening a window', windows, () => {
  // A nonexistent state remains a second guard even if a future edit breaks the test check.
  const result = spawnSync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-StatePath', join(tmpdir(), 'not-a-maintenance-job', 'state.json'), '-JobId', 'install-testguard', '-Locale', 'en'], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000, env: { ...process.env, DSH_BROWSER_TEST: '1' },
  })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(JSON.parse(result.stdout.trim()).code, 'TEST_CONTEXT_REFUSED')
})
