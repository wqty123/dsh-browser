// Delivery: a saved file handed to an MCP tool, from a setting the user owns.
//
// The failure this guards is the quiet one: a download that says "done" while the remote copy never
// happened. Every case below asserts BOTH halves of the answer — where the file is, and what the
// remote side said — because reporting one of them is how a "saved to Feishu" message becomes a lie.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'dsh-builtin-browser-host'), { recursive: true })

const { apply } = await import('../lib/tool-browser/index.js')

/** Write the settings document this test's plugin instance will read. */
function settings(delivery) {
  writeFileSync(join(home, 'dsh-builtin-browser-host', 'settings.json'), JSON.stringify({ delivery }), 'utf8')
}

/** A real file, so the {size} placeholder has something to substitute. */
const savedFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-download-'))
  const path = join(dir, 'report.pdf')
  writeFileSync(path, 'x'.repeat(1024))
  return path
})()

/** A context with a tools service that records the handoff call. */
function makeContext(handoff = async () => ({ isError: false, value: { uploaded: true } }), batched = true) {
  const registered = new Map()
  const calls = []
  const ctx = {
    tools: {
      register: tool => { registered.set(tool.name, tool); return () => {} },
      ...(batched ? { setExecutor() {} } : {}),
      execute: async input => {
        calls.push(input)
        if (!batched) return await handoff(input)
        assert.equal(input.calls.length, 1)
        assert.equal(input.calls[0].type, 'tool-call')
        assert.equal(typeof input.calls[0].arguments, 'string')
        return {
          results: [{ callId: input.calls[0].id, result: await handoff(input) }],
          additionalContexts: [],
          concluded: false,
        }
      },
    },
    systemPrompt: { section: () => undefined },
    effect: () => undefined,
    logger: { warn: () => {} },
    get: name => {
      if (name === 'tools') return ctx.tools
      if (name === 'browser') {
        return {
          open: async () => 'session-1',
          exists: () => true,
          download: async () => ({ path: savedFile }),
        }
      }
      return undefined
    },
  }
  return { ctx, registered, calls }
}

const run = async (delivery, handoff, batched = true) => {
  settings(delivery)
  const built = makeContext(handoff, batched)
  apply(built.ctx, {})
  const tool = built.registered.get('dsh_browser_download')
  const exec = { callId: 'download-1', rootCallId: 'root-1', token: Symbol('outer'), signal: new AbortController().signal, agent: { id: 'task-1' }, toolSet: { view() {} }, deferContext() {}, concludeTurn() {} }
  const value = await tool.execute({ url: 'https://example.com/report.pdf', savePath: savedFile }, exec)
  return { value, calls: built.calls, tool, exec }
}

test('an empty tool keeps the old behaviour exactly', async () => {
  const { value, calls } = await run({ tool: '', args: { file_path: '{path}' }, onFail: 'keep-local', sites: {} })
  assert.deepEqual(value, { path: savedFile }, 'the result is the path and nothing else')
  assert.equal(calls.length, 0, 'nothing was handed off')
})

test('a configured tool receives the file path, and both halves are reported', async () => {
  const { value, calls, exec } = await run({ tool: 'lark_drive_upload', args: { file_path: '{path}', name: '{name}', size: '{size}' }, onFail: 'keep-local', sites: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].calls[0].name, 'lark_drive_upload')
  assert.deepEqual(JSON.parse(calls[0].calls[0].arguments), { file_path: savedFile, name: 'report.pdf', size: '1024' })
  assert.equal(calls[0].agent, exec.agent, 'scoped tools and permissions belong to the downloading agent')
  assert.equal(calls[0].toolSet, exec.toolSet, 'the model step admission is preserved')
  assert.equal(calls[0].signal, exec.signal, 'upload cancellation follows the download call')
  assert.equal(value.path, savedFile, 'the local path is still reported')
  assert.equal(value.handoff.tool, 'lark_drive_upload', 'and so is the remote result')
  assert.equal(value.remoteError, undefined)
})

test('a failing handoff keeps the local file and says both things', async () => {
  const { value } = await run(
    { tool: 'lark_drive_upload', args: { file_path: '{path}' }, onFail: 'keep-local', sites: {} },
    async () => { throw new Error('token expired') },
  )
  assert.equal(value.path, savedFile, 'the local file is not denied because the remote failed')
  assert.match(value.remoteError, /lark_drive_upload: token expired/, 'the remote failure is carried, with the tool that failed')
  assert.equal(value.handoff, undefined, 'and it is not dressed up as a handoff')
})

test('onFail "stop" reports the failure instead of a quiet success', async () => {
  await assert.rejects(
    () => run({ tool: 'lark_drive_upload', args: {}, onFail: 'stop', sites: {} }, async () => { throw new Error('quota exceeded') }),
    /saved to .* locally, but the handoff to "lark_drive_upload" failed: quota exceeded/,
  )
})

test('a per-site override outranks the default tool', async () => {
  const { calls } = await run({ tool: 'lark_drive_upload', args: { file_path: '{path}' }, onFail: 'keep-local', sites: { 'pan.baidu.com': 'netdisk_upload' } })
  // The download URL is example.com in this harness, so the default applies.
  assert.equal(calls[0].calls[0].name, 'lark_drive_upload')
  const second = await run({ tool: 'lark_drive_upload', args: {}, onFail: 'keep-local', sites: { 'example.com': 'netdisk_upload' } })
  assert.equal(second.calls[0].calls[0].name, 'netdisk_upload', 'a matching host wins')
})

test('a settled denied upload is a failed delivery with its local file preserved', async () => {
  const { value } = await run(
    { tool: 'upload', args: {}, onFail: 'keep-local', sites: {} },
    async () => ({ isError: true, error: { message: 'upload permission denied' }, content: [] }),
  )
  assert.equal(value.path, savedFile)
  assert.match(value.remoteError, /upload permission denied/)
  assert.equal(value.handoff, undefined)
})

test('legacy execution keeps the agent and enclosing execution identity', async () => {
  const { value, calls, exec } = await run(
    { tool: 'upload', args: {}, onFail: 'keep-local', sites: {} },
    async () => ({ isError: false, value: { url: 'https://files.example/report.pdf' } }),
    false,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'upload')
  assert.deepEqual(calls[0].arguments, { file_path: savedFile })
  assert.equal(calls[0].agent, exec.agent)
  assert.equal(calls[0].parent, exec.token)
  assert.equal(calls[0].rootCallId, exec.rootCallId)
  assert.match(value.handoff.result, /files.example/)
})

test('missing and malformed executor outcomes never claim delivery', async () => {
  for (const outcome of [undefined, null, { ok: true }]) {
    const { value } = await run(
      { tool: 'upload', args: {}, onFail: 'keep-local', sites: {} },
      async () => outcome,
    )
    assert.match(value.remoteError, /invalid tool result/)
    assert.equal(value.handoff, undefined)
  }
})

test('a self-referencing delivery setting stops before recursive dispatch', async () => {
  const { value, calls } = await run({ tool: 'dsh_browser_download', args: {}, onFail: 'keep-local', sites: {} })
  assert.equal(calls.length, 0)
  assert.match(value.remoteError, /different tool/)
})

test('the full destination value survives a shortened display summary', async () => {
  const destination = { url: 'https://files.example/' + 'report/'.repeat(50) + 'report.pdf', name: 'report.pdf' }
  const { value } = await run(
    { tool: 'upload', args: {}, onFail: 'keep-local', sites: {} },
    async () => ({ isError: false, value: destination }),
  )
  assert.equal(value.handoff.result.length, 201)
  assert.deepEqual(value.handoff.value, destination)
})

test('caller cancellation is propagated after a receiver failure', async () => {
  const controller = new AbortController()
  const built = makeContext(async () => {
    controller.abort(new Error('delivery cancelled'))
    throw controller.signal.reason
  })
  settings({ tool: 'upload', args: {}, onFail: 'keep-local', sites: {} })
  apply(built.ctx, {})
  await assert.rejects(
    built.registered.get('dsh_browser_download').execute(
      { url: 'https://example.com/report.pdf', savePath: savedFile },
      { signal: controller.signal, agent: { id: 'task-cancel' } },
    ),
    /delivery cancelled/,
  )
})

test('explicit MCP and cloud failure payloads preserve their raw result', async () => {
  const payloads = [
    { status: 'error', message: 'Baidu upload failed' },
    { isError: true, content: [{ type: 'text', text: 'upload refused' }] },
    { structuredContent: { success: false, message: 'quota exceeded' }, content: [] },
    { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'token expired' }) }] },
    JSON.stringify({ ok: false, error: 'upload rejected' }),
  ]
  for (const payload of payloads) {
    const { value } = await run(
      { tool: 'upload_file', args: {}, onFail: 'keep-local', sites: {} },
      async () => ({ isError: false, value: payload }),
    )
    assert.equal(value.path, savedFile)
    assert.equal(value.handoff, undefined)
    assert.ok(value.remoteError)
    assert.deepEqual(value.remoteResult, { tool: 'upload_file', value: payload })
  }
})

test('successful structured MCP values and unstructured text remain intact', async () => {
  for (const payload of [
    { status: 'success', remote_path: '/browser/report.pdf' },
    { structuredContent: { ok: true, url: 'https://files.example/report.pdf' }, content: [] },
    { content: [{ type: 'text', text: 'Upload complete' }] },
    { records: [{ status: 'error', message: 'historical record' }], url: 'https://files.example/report.pdf' },
  ]) {
    const { value } = await run(
      { tool: 'upload_file', args: {}, onFail: 'keep-local', sites: {} },
      async () => ({ isError: false, value: payload }),
    )
    assert.equal(value.remoteError, undefined)
    assert.deepEqual(value.handoff.value, payload)
  }
})
