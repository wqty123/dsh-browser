// The operator switches must actually refuse — and they are the operator's, not the model's.
//
// These are the settings panel's "what the agent may do" switches. Unlike `browser_restrict`
// (a soft guardrail the model owns and can lift whenever it likes) they live in the settings
// document, which no tool can write, so a refusal here stands. The tests pin the refusal and
// its immediacy; that nothing can lift it follows from there being no tool that writes the
// document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ElectronBrowserProvider } = await import('../lib/browser-electron/provider.js')
const { DEFAULT_SETTINGS, resolveSettings } = await import('../lib/browser-electron/settings-store.js')

const IMAGE_BASE64 = Buffer.from('fake-png-bytes').toString('base64')

/**
 * Minimal host stub: one view per createView(), answering the commands these paths send.
 * `download` records instead of transferring — the transfer is not what is under test.
 */
function makeHost() {
  let counter = 0
  const downloads = []
  return {
    downloads,
    createView() {
      return {
        id: `view${++counter}`,
        async sendCommand(method) {
          if (method === 'Runtime.evaluate') return { result: { value: 'about:blank' } }
          return {}
        },
        async download(url, savePath) { downloads.push({ url, savePath }) },
        async capture() { return { base64: IMAGE_BASE64, mime: 'image/png' } },
      }
    },
    destroyView() {},
    showView() {},
    groupView() {},
    onUserAction() {},
  }
}

/** A settings document with the action switches overridden; everything else stays default. */
const settingsWith = (actions) => resolveSettings({ actions })

test('the action switches default to on, and a hand-edited file cannot loosen them wrongly', () => {
  assert.deepEqual(DEFAULT_SETTINGS.actions, { allowExecute: true, allowDownload: true, allowCredentialWrite: true })
  const resolved = resolveSettings({ actions: { allowExecute: 'yes', allowDownload: false, somethingElse: 1 } })
  assert.equal(resolved.actions.allowExecute, true, 'a mistyped value falls back to the default')
  assert.equal(resolved.actions.allowDownload, false, 'a real boolean is honoured')
  assert.equal(resolved.actions.allowCredentialWrite, true, 'an absent field takes its default')
  assert.equal('somethingElse' in resolved.actions, false, 'unknown keys are dropped')
})

test('with every switch on (the default), all three paths work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gates-'))
  const provider = new ElectronBrowserProvider(makeHost(), {
    downloadDir: dir,
    settings: () => settingsWith({}),
  })
  const session = await provider.open()
  try {
    await provider.execute(session, { script: '1 + 1' })
    const target = join(dir, 'file.bin')
    const downloaded = await provider.download(session, { url: 'https://a.example/f', savePath: target })
    assert.equal(downloaded.path, target)
    await provider.restoreAuth(session, [{ name: 'sid', value: 'x', domain: 'example.com', path: '/' }])
  } finally {
    await provider.close(session)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a switched-off page-script action refuses execute, and says which switch', async () => {
  const provider = new ElectronBrowserProvider(makeHost(), { settings: () => settingsWith({ allowExecute: false }) })
  const session = await provider.open()
  try {
    await assert.rejects(
      () => provider.execute(session, { script: '1 + 1' }),
      /running page scripts is switched off in settings/,
    )
  } finally {
    await provider.close(session)
  }
})

test('a switched-off download action refuses before the path is even considered', async () => {
  const provider = new ElectronBrowserProvider(makeHost(), { settings: () => settingsWith({ allowDownload: false }) })
  const session = await provider.open()
  try {
    // A save path that admission would ALSO reject: the reported reason must be the switch,
    // not the path, because the switch is the thing the operator chose.
    await assert.rejects(
      () => provider.download(session, { url: 'https://a.example/f', savePath: 'relative.bin' }),
      /downloads are switched off in settings/,
    )
  } finally {
    await provider.close(session)
  }
})

test('reading and writing login state are separate switches', async () => {
  // Writing answers to the WRITE switch. It used to answer to the read switch and report
  // "reading cookies is switched off" — the wrong gate named by the wrong sentence, which
  // left an operator who allowed reading no way to refuse writes.
  const writes = resolveSettings({ credentials: { allowRead: false }, actions: { allowCredentialWrite: true } })
  const provider = new ElectronBrowserProvider(makeHost(), { settings: () => writes })
  const session = await provider.open()
  try {
    await assert.rejects(() => provider.flushAuth(session), /reading cookies is switched off in settings/)
    await provider.restoreAuth(session, [{ name: 'sid', value: 'x', domain: 'example.com', path: '/' }])
  } finally {
    await provider.close(session)
  }

  const noWrites = resolveSettings({ credentials: { allowRead: true }, actions: { allowCredentialWrite: false } })
  const second = new ElectronBrowserProvider(makeHost(), { settings: () => noWrites })
  const otherSession = await second.open()
  try {
    await assert.rejects(
      () => second.restoreAuth(otherSession, [{ name: 'sid', value: 'x', domain: 'example.com', path: '/' }]),
      /writing cookies is switched off in settings/,
    )
  } finally {
    await second.close(otherSession)
  }
})

test('a switch flipped while the plugin runs applies to the very next command', async () => {
  // The gate reads the settings document on every call rather than capturing it at
  // construction, which is what makes the panel's "applies immediately, no restart" true.
  const host = makeHost()
  let actions = {}
  const provider = new ElectronBrowserProvider(host, { settings: () => resolveSettings({ actions }) })
  const session = await provider.open()
  try {
    await provider.execute(session, { script: '1' })
    actions = { allowExecute: false }
    await assert.rejects(() => provider.execute(session, { script: '1' }), /running page scripts is switched off/)
    actions = {}
    await provider.execute(session, { script: '1' })
  } finally {
    await provider.close(session)
  }
})
