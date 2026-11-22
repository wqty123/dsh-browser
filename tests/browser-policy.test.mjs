import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cdpVersionUrl, extensionPageUrl, folderOpener } from '../assets/browser-policy.mjs'
import { extensionMessages } from '../assets/browser-messages.mjs'
import { zh, en } from '../assets/browser-panel-locales.mjs'
import { NativeBrowserClient } from '../native-host/client.mjs'
import { windowsPowerShellPath } from '../lib/browser-electron/windows-system.js'

test('browser URLs and folder openers retain their platform-specific policy', () => {
  assert.equal(cdpVersionUrl(12345), 'http://127.0.0.1:12345/json/version')
  assert.equal(extensionPageUrl('edge'), 'edge://extensions')
  assert.equal(extensionPageUrl('chrome'), 'chrome://extensions')
  for (const [platform, command] of [['win32', 'explorer.exe'], ['darwin', 'open'], ['linux', 'xdg-open']]) {
    assert.equal(folderOpener(platform), command)
  }
})

test('Windows PowerShell discovery uses the running system and fails closed without it', () => {
  const expected = String.raw`Z:\OS\System32\WindowsPowerShell\v1.0\powershell.exe`
  assert.equal(windowsPowerShellPath({ SystemRoot: 'Z:\\OS' }, path => path === expected), expected)
  assert.equal(windowsPowerShellPath({ windir: 'Z:\\OS' }, () => true), expected)
  assert.throws(() => windowsPowerShellPath({}, () => true), /system directory is unavailable/)
  assert.throws(() => windowsPowerShellPath({ SystemRoot: 'relative' }, () => true), /system directory is unavailable/)
  assert.throws(() => windowsPowerShellPath({ SystemRoot: 'Z:\\OS' }, () => false), /PowerShell is unavailable/)
})

test('missing extension status and both panel locales describe automatic CDP fallback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const status = new NativeBrowserClient(dir, 'edge').status()
  assert.equal(status.state, 'extension-missing')
  assert.equal(status.detail, extensionMessages.en.notConnected)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ browser: 'edge', installId: 'bundled' }))
  assert.equal(new NativeBrowserClient(dir, 'edge').status().state, 'not-connected')
  assert.equal(new NativeBrowserClient(dir, 'edge').status().detail, status.detail)
  writeFileSync(join(dir, 'config.json'), '{invalid')
  assert.equal(new NativeBrowserClient(dir, 'edge').status().detail, status.detail)
  assert.equal(en['extension.notConnected'], extensionMessages.en.notConnected)
  assert.equal(zh['extension.notConnected'], extensionMessages.zh.notConnected)
  for (const locale of [en, zh]) {
    assert.match(locale['extension.notConnected'], /CDP/)
    assert.equal(Object.keys(locale).length, Object.keys(en).length)
  }
})
