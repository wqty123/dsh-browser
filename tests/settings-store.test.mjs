// Plugin settings document: defaults, tolerant parsing, persistence, and the
// live switch that makes the panel's choices take effect without a restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, SettingsStore, resolveSettings } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** A unique settings file per test. */
function settingsFile() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-settings-')), 'settings.json')
}

/** Read the history file, or '' when it does not exist yet. */
function readHistory(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Poll until fn() is truthy or the budget runs out. */
async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Host stub answering the probes a navigation makes (stamp + url/title). */
function makeHost() {
  // The document stamp must change per navigation, exactly like a real load,
  // and the URL must reflect the address actually navigated to.
  let loads = 0
  let current = 'about:blank'
  return {
    createView() {
      return {
        id: 'view1',
        async sendCommand(method, params) {
          if (method === 'Page.navigate') { loads += 1; current = params.url; return {} }
          if (method === 'Runtime.evaluate') {
            const expr = params.expression ?? ''
            if (expr.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
            if (expr.includes('document.title')) return { result: { value: `${current}\u0000Example` } }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    destroyView() {}, showView() {}, groupView() {}, onUserAction() {},
  }
}

test('a missing file resolves to the documented defaults', () => {
  const store = new SettingsStore(settingsFile())
  assert.deepEqual(store.get(), DEFAULT_SETTINGS)
  assert.equal(store.get().history.enabled, true, 'history records by default')
  assert.equal(store.get().ui.autoExpandOnce, true, 'auto-expand is once-per-task by default')
  assert.equal(store.get().ui.closeWithSession, false, 'closing the interface is not the default end of a session')
})

test('partial and mistyped fields fall back per field, unknown keys are dropped', () => {
  const resolved = resolveSettings({
    history: { enabled: false, maxEntries: 'lots', maxAgeDays: 7 },
    ui: { virtualCursor: false },
    somethingElse: { sneaky: true },
  })
  assert.equal(resolved.history.enabled, false, 'valid boolean kept')
  assert.equal(resolved.history.maxEntries, DEFAULT_SETTINGS.history.maxEntries, 'mistyped number falls back')
  assert.equal(resolved.history.maxAgeDays, 7)
  assert.equal(resolved.ui.virtualCursor, false)
  assert.equal(resolved.ui.autoExpandOnce, true, 'untouched field keeps its default')
  assert.equal('somethingElse' in resolved, false, 'unknown sections are not smuggled through')
})

test('update merges, persists, and reads back', () => {
  const file = settingsFile()
  const store = new SettingsStore(file)
  store.update({ history: { enabled: false } })
  store.update({ ui: { autoExpandOnce: false } })

  const reread = new SettingsStore(file).get()
  assert.equal(reread.history.enabled, false, 'first patch persisted')
  assert.equal(reread.history.maxEntries, DEFAULT_SETTINGS.history.maxEntries, 'merge kept sibling fields')
  assert.equal(reread.ui.autoExpandOnce, false, 'second patch persisted')

  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.history.enabled, false)
})

test('a malformed file refuses the capability gates instead of failing or defaulting', () => {
  // The behaviour changed on purpose. A file that exists and cannot be parsed used to resolve to
  // DEFAULT_SETTINGS, which meant a torn write (a TerminateProcess during the save) or one stray
  // character silently reopened every switch the operator had turned off — and the next save
  // wrote those defaults to disk for good. "No file" is still a first run and still takes the
  // defaults; "a file I cannot read" is not the same statement.
  const file = settingsFile()
  writeFileSync(file, '{ this is not json')
  const resolved = new SettingsStore(file).get()

  assert.equal(resolved.credentials.allowRead, false, 'cookie reading is not granted by a corrupt file')
  assert.deepEqual(resolved.actions, { allowExecute: false, allowDownload: false, allowCredentialWrite: false })

  // Everything that is merely convenient keeps its default: refusing history or the browser
  // choice would punish the user for a corrupt file without protecting anything.
  assert.deepEqual(resolved.history, DEFAULT_SETTINGS.history)
  assert.deepEqual(resolved.ui, DEFAULT_SETTINGS.ui)
  assert.deepEqual(resolved.browser, DEFAULT_SETTINGS.browser)

  // And a file that is simply ABSENT — a first run — still gets the documented defaults.
  const fresh = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'dsh-settings-new-')), 'settings.json')).get()
  assert.deepEqual(fresh, DEFAULT_SETTINGS)
})

test('the provider honours a settings switch flipped at runtime', async () => {
  let settings = { ...DEFAULT_SETTINGS, history: { ...DEFAULT_SETTINGS.history, enabled: true } }
  const history = join(mkdtempSync(join(tmpdir(), 'dsh-settings-hist-')), 'history.jsonl')
  const p = new ElectronBrowserProvider(makeHost(), {
    history: { file: history },
    settings: () => settings,
  })
  const sid = await p.open()

  await p.navigate(sid, { url: 'https://example.com/one' })
  assert.ok(await waitFor(() => readHistory(history).includes('/one')), 'recorded while enabled')

  settings = { ...settings, history: { ...settings.history, enabled: false } }
  await p.navigate(sid, { url: 'https://example.com/two' })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(readHistory(history).includes('/two'), false, 'nothing recorded once switched off')
  assert.ok(readHistory(history).includes('/one'), 'earlier records were kept')
  await p.close(sid)
})

// A hand-edited settings file has to survive the editor. Notepad and PowerShell's
// `Set-Content -Encoding utf8` both write a leading BOM, and JSON.parse rejects it —
// so without a strip the document looked correct while every value in it was silently
// discarded and the plugin ran on defaults (including switches just turned off).
test('a settings file written with a UTF-8 BOM is still honoured', () => {
  const file = settingsFile()
  const document = { vision: { strategy: 'nonVisual' }, ui: { autoExpandOnce: false, virtualCursor: false } }
  writeFileSync(file, `\uFEFF${JSON.stringify(document)}`)
  const settings = new SettingsStore(file).get()
  assert.equal(settings.vision.strategy, 'nonVisual', 'the strategy survived the BOM')
  assert.equal(settings.ui.autoExpandOnce, false, 'so did the switches')
  assert.equal(settings.ui.virtualCursor, false)
  assert.equal(settings.history.enabled, DEFAULT_SETTINGS.history.enabled, 'unspecified fields keep defaults')
})
