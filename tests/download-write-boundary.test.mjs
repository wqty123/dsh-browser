import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import vm from 'node:vm'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

const source = fs.readFileSync(new URL('../lib/browser-electron/host-main.js', import.meta.url), 'utf8')
const begin = source.indexOf('async function handle(')
const end = source.indexOf('\n}', begin) + 2
assert.ok(begin >= 0 && end > begin)
const helperUrl = new URL('../lib/browser-electron/file-write.js', import.meta.url)
const helpers = fs.existsSync(helperUrl) ? await import(helperUrl.href) : {}

async function withDownload(run, duringFetch = () => {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dsh-download-boundary-'))
  const directory = path.join(root, 'Downloads')
  fs.mkdirSync(directory)
  let response
  const handle = vm.runInNewContext(source.slice(begin, end) + ';handle', {
    ...fs, ...path, ...helpers, Buffer, JSON, Number, String, Array, Error, Set, Map, process,
    MAX_DOWNLOAD_BYTES: 256 * 1024 * 1024, COMMAND_TIMEOUT_MS: 20000,
    withTimeout: promise => promise,
    windowOfView: () => ({ views: new Map([['v', {
      webContentsView: { webContents: { debugger: { sendCommand: async () => {
        duringFetch(directory)
        return { result: { value: Buffer.from('downloaded bytes').toString('base64') } }
      } } } },
    }]]) }),
    reply: (_id, value) => { response = value },
  })
  const host = {
    createView() { return {
      id: 'v', sendCommand: async () => ({}),
      async download(url, savePath) {
        await handle('download', { id: 1, viewId: 'v', url, savePath })
        if (!response?.ok) throw new Error(response?.err)
      },
    } },
    destroyView() {},
  }
  const provider = new ElectronBrowserProvider(host, { downloadDir: directory, history: { enabled: false } })
  const session = await provider.open('audit-download')
  try { await run({ root, directory, provider, session }) }
  finally {
    await provider.close(session)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('download leaves an existing .part hard link and its outside target untouched', async () => {
  await withDownload(async ({ root, directory, provider, session }) => {
    const outside = path.join(root, 'important.txt')
    const target = path.join(directory, 'report.txt')
    fs.writeFileSync(outside, 'keep outside data')
    fs.linkSync(outside, target + '.part')
    await provider.download(session, { url: 'https://example.com/file', savePath: target })
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside data')
    assert.equal(fs.readFileSync(target + '.part', 'utf8'), 'keep outside data')
    assert.equal(fs.readFileSync(target, 'utf8'), 'downloaded bytes')
  })
})

test('download refuses a final file created while the network request was pending', async () => {
  await withDownload(async ({ directory, provider, session }) => {
    const target = path.join(directory, 'report.txt')
    await assert.rejects(() => provider.download(session, { url: 'https://example.com/file', savePath: target }))
    assert.equal(fs.readFileSync(target, 'utf8'), 'created by another writer')
    assert.deepEqual(fs.readdirSync(directory), ['report.txt'], 'failed commit cleans its temporary file')
  }, directory => fs.writeFileSync(path.join(directory, 'report.txt'), 'created by another writer'))
})

test('provider passes the calling task to carrier page listing and closing', async () => {
  const calls = []
  const provider = new ElectronBrowserProvider({
    createView: () => ({ id: 'v', sendCommand: async () => ({}) }),
    destroyView() {},
    async listPages(owner) { calls.push(['list', owner]); return [{ id: 'extra', url: 'https://example.com/' }] },
    async closePage(id, owner) { calls.push(['close', id, owner]) },
  }, { history: { enabled: false } })
  const session = await provider.open('session-audit')
  try {
    await provider.listTabs(session)
    await provider.closeTab(session, 'page:extra')
    assert.deepEqual(calls, [['list', 'session-audit'], ['close', 'extra', 'session-audit']])
    assert.throws(() => provider.closeTab('unknown', 'page:extra'))
    assert.equal(calls.length, 2, 'an invalid session cannot close a carrier page')
  } finally { await provider.close(session) }
})
