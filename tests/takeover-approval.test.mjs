import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import ts from 'typescript'
import { ApprovalContract } from './fixtures/takeover-host.mjs'

function harness(Service) {
  const events = new Context(), audit = []
  let turnOpen = true
  const service = Object.create(Service.prototype)
  Object.defineProperty(service, 'ctx', { value: events })
  service.approvalStateOf = () => ({ turnOpen })
  service.effectivePolicy = () => 'ask'
  const agent = { session: { append: (kind, data) => audit.push({ kind, ...data }) } }
  return { events, audit, service, agent, closeTurn() { turnOpen = false } }
}

async function contract(t, Service) {
  for (const decision of ['allowed-once', 'rejected', 'cancelled', 'unavailable', 'denied', 'throw', 'missing']) {
    await t.test(`answer ${decision}`, async () => {
      const { events, audit, service, agent } = harness(Service)
      const request = { agent, toolName: 'dsh_browser_request_takeover', reason: 'Login', callId: 'call',
        displayReason: { en: 'Please take over', zh: '请接管浏览器' } }
      if (decision !== 'missing') events.on('approval/request', received => {
        assert.equal(received, request)
        if (decision === 'throw') throw new Error('answerer failed')
        return Promise.resolve(decision)
      })
      const expected = ['denied', 'throw', 'missing'].includes(decision) ? 'unavailable' : decision
      assert.equal(await service.request(request), expected)
      assert.deepEqual(audit.map(event => event.kind), ['approval/asked', 'approval/decided'])
      assert.equal(audit[0].toolName, request.toolName)
      assert.equal(audit[0].callId, request.callId)
      assert.equal(audit[0].reason, request.reason)
      assert.equal(audit[1].id, audit[0].id)
      assert.equal(audit[1].outcome, expected)
    })
  }
  await t.test('requires an open turn and audits an already-aborted request without dispatch', async () => {
    const { events, audit, service, agent, closeTurn } = harness(Service)
    events.on('approval/request', () => { assert.fail('an already-aborted request must not dispatch') })
    const request = { agent, toolName: 'dsh_browser_request_takeover', signal: AbortSignal.abort() }
    assert.equal(await service.request(request), 'cancelled')
    assert.equal(audit.length, 2)
    closeTurn()
    await assert.rejects(service.request(request), /outside an open turn/)
    assert.equal(audit.length, 2)
  })
  for (const mode of ['card-first', 'button-first-no-abort', 'button-first-abort', 'button-first-abort-after-decision']) {
    await t.test(mode, async () => {
      const { events, audit, service, agent } = harness(Service), controller = new AbortController()
      let buttonAnswer, cardAnswer, presented, answerable = true
      const button = new Promise(resolve => { buttonAnswer = resolve }), ready = new Promise(resolve => { presented = resolve })
      events.on('approval/request', async (_request, next) => Promise.race([button, next()]))
      events.on('approval/request', request => new Promise(resolve => {
        const abort = () => { cardAnswer('cancelled') }
        cardAnswer = decision => {
          if (!answerable) return
          answerable = false
          request.signal.removeEventListener('abort', abort)
          resolve(decision)
        }
        request.signal.addEventListener('abort', abort, { once: true })
        presented()
      }))
      const result = service.request({ agent, toolName: 'dsh_browser_request_takeover', signal: controller.signal })
      await ready
      if (mode === 'card-first') cardAnswer('allowed-once')
      else buttonAnswer('allowed-once')
      if (mode === 'button-first-abort') controller.abort()
      const expected = mode === 'button-first-abort' ? 'cancelled' : 'allowed-once'
      assert.equal(await result, expected)
      if (mode === 'button-first-abort-after-decision') controller.abort()
      assert.equal(answerable, mode === 'button-first-no-abort')
      assert.equal(audit.at(-1).outcome, expected)
      controller.abort()
      assert.equal(answerable, false)
    })
  }
}

test('local ask-policy approval fixture conforms to rc.5', t => contract(t, ApprovalContract))

test('installed rc.5 approval service conforms to the same contract (opt-in)', {
  skip: process.env.DSH_TEST_REAL_APPROVAL !== '1' && 'set DSH_TEST_REAL_APPROVAL=1 to probe the installed host approval service',
}, async t => {
  let entry
  try { entry = import.meta.resolve('@deepseek-ai/dsh-user-approval') }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('@deepseek-ai/dsh-user-approval is not installed')
    return
  }
  const { ApprovalService } = await import(entry)
  await contract(t, ApprovalService)
})

test('default takeover fixture loads with host approval package imports explicitly blocked', () => {
  const hook = `export function resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-user-approval' || specifier.startsWith('@deepseek-ai/dsh-user-approval/')) {
      throw Object.assign(new Error('host approval package is unavailable'), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    return next(specifier, context)
  }`
  const register = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hook))});`
  const loaders = process.execArgv.flatMap((arg, index, args) => arg === '--import' ? [arg, args[index + 1]] : [])
  const child = spawnSync(process.execPath, [...loaders, '--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    await assert.rejects(import('@deepseek-ai/dsh-user-approval'), { code: 'ERR_MODULE_NOT_FOUND' });
    const { takeoverHost } = await import(${JSON.stringify(new URL('./fixtures/takeover-host.mjs', import.meta.url).href)});
    const host = takeoverHost();
    assert.ok(host.tools.has('dsh_browser_request_takeover'));
    host.dispose();
  `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stdout + child.stderr)
})

test('production has no host approval import and takeover uses only existing workspace dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.devDependencies)])
  const takeoverFiles = new Set(['takeover-protocol.ts', 'tool-browser/index.ts', 'tool-browser/takeover.ts',
    'client/browser/takeover-channel.ts', 'client/browser/iframe-reference.ts', 'client/view/TakeoverBanner.tsx',
    'client/view/BrowserBody.tsx', 'client/view/IframePresentation.ts', 'browser-electron/guest-runtime.ts'])
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name, url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      if (entry.isDirectory()) { if (entry.name !== '__tests__') await visit(url, path + '/'); continue }
      if (!/\.tsx?$/u.test(entry.name)) continue
      for (const { fileName: specifier } of ts.preProcessFile(await readFile(url, 'utf8'), true, true).importedFiles) {
        assert.ok(!/^@deepseek-ai\/dsh-user-approval(?:\/|$)/u.test(specifier), `${path}: host approval must be injected, not imported`)
        if (!takeoverFiles.has(path) || specifier.startsWith('.') || isBuiltin(specifier)) continue
        const root = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        assert.ok(declared.has(root) || root === 'react', `${path}: undeclared takeover dependency ${specifier}`)
      }
    }
  }
  await visit(new URL('../src/', import.meta.url))
})
