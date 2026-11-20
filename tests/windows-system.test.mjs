import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsPowerShellPath } from '../lib/browser-electron/windows-system.js'

test('Windows system tools follow the current system drive and case-insensitive environment', () => {
  const inspected = []
  const exists = path => { inspected.push(path); return true }
  assert.equal(windowsPowerShellPath({ systemroot: 'R:/Custom System' }, exists), 'R:\\Custom System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(windowsPowerShellPath({ WINDIR: 'S:/Windows' }, exists), 'S:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(inspected.length, 2)
})
test('missing system environment or executable returns a concrete failure instead of assuming a drive', () => {
  assert.throws(() => windowsPowerShellPath({}, () => true), /SystemRoot or WINDIR/)
  assert.throws(() => windowsPowerShellPath({ SystemRoot: 'relative' }, () => true), /SystemRoot or WINDIR/)
  assert.throws(() => windowsPowerShellPath({ SystemRoot: 'R:/Windows' }, () => false), /PowerShell is unavailable/)
})
