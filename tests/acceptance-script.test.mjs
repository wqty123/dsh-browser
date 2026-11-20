// Prove the acceptance script can FAIL, not just pass.
//
// `tools/accept-desktop.mjs` is what a restart gets spent on. A checker that always reports
// success would waste that restart in the worst way — it would look like the work was done. So
// the script is run three times here against fake bridges: one correct, one that reuses a page
// instead of opening one (this session's first bug), one that opens extra pages (this session's
// fifth). The correct one must pass; the other two must fail.
import { createServer } from 'node:net'
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTabHandle, resolveSessionHandle, tabWireId } from '../lib/browser/handles.js'

/** A fake bridge that answers the ops the acceptance script uses. */
function makeBridge (broken = '') {
  const guests = []
  if (broken.startsWith('protected-')) {
    guests.push({ id: 90, owner: 'session-acceptance', title: 'user page', url: 'https://user.example/' })
    guests.push({ id: 91, owner: 'session-other', title: 'other user page', url: 'https://other.example/' })
  }
  const requests = []
  const views = new Map()
  const bindings = new Map()
  const pageHandle = (scope, guest) => {
    for (const [handle, id] of bindings) {
      const held = readTabHandle(handle)
      if (id === guest.id && held.owner === scope.owner && held.session === scope.session) return handle
    }
    const handle = tabWireId({ ...scope, tab: `page:${guest.id}` })
    bindings.set(handle, guest.id)
    return handle
  }
  let nextId = 2
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let cut
      while ((cut = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        if (line.trim() === '') continue
        const request = JSON.parse(line)
        requests.push(request)
        const reply = (body) => socket.write(JSON.stringify({ ...body, bridgeRequestId: request.bridgeRequestId }) + '\n')
        const scope = request.op === 'version' ? undefined
          : request.op === 'list' ? resolveSessionHandle(request.handle) : readTabHandle(request.handle)
        const owner = scope?.owner

        if (request.op === 'version') {
          // A loadedAt in the future is always newer than the file on disk, which is what the
          // acceptance script's first check compares against.
          reply({ ok: true, loadedAt: new Date(Date.now() + 60_000).toISOString(), protocol: 4 })
          continue
        }
        if (request.op === 'list') {
          if (broken === 'list-error') {
            reply({ ok: false, error: 'list unavailable' })
            continue
          }
          const mine = guests.filter(g => g.owner === owner)
          reply({ ok: true, sidebar: mine.map(g => ({ id: pageHandle(scope, g), url: g.url, title: g.title, type: 'webview' })) })
          continue
        }
        if (request.op === 'ensureSidebar') {
          if (!/^session-.+/.test(owner) || typeof request.handle !== 'string') {
            reply({ ok: false, error: 'a conversation and logical view are required' })
            continue
          }
          if (broken === 'refuse') {
            reply({ ok: false, error: 'panel unavailable' })
            continue
          }
          const key = request.handle
          if ((broken === 'protected-first' && views.size === 0)
            || (broken === 'protected-second' && views.size === 1)
            || (broken === 'protected-other' && owner === 'session-other')
            || (broken === 'protected-reopen' && views.has(key))) {
            reply({ ok: true, id: pageHandle(scope, guests.find(g => g.owner === owner)), reused: true })
            continue
          }
          if (views.has(key)) {
            reply({ ok: true, id: key })
            continue
          }
          if (guests.some(g => g.owner === owner) && broken === 'reuse') {
            reply({ ok: true, created: false, id: pageHandle(scope, guests[0]), reused: true })
            continue
          }
          const id = nextId++
          views.set(key, id)
          bindings.set(key, id)
          guests.push({ id, url: 'about:blank', title: 'page ' + id, owner })
          if (broken === 'spray') {
            const extra = nextId++
            guests.push({ id: extra, url: 'about:blank', title: 'page ' + extra, owner })
          }
          reply({ ok: true, created: true, id: key })
          continue
        }
        if (request.op === 'showTab') { reply({ ok: true, verdict: 'CLICKED' }); continue }
        if (request.op === 'closePage') {
          const index = guests.findIndex(g => g.id === bindings.get(request.handle) && g.owner === owner)
          if (index !== -1) guests.splice(index, 1)
          reply({ ok: index !== -1, closed: index === -1 ? 0 : 1 })
          continue
        }
        if (request.op === 'cdp') {
          const guest = guests.find(g => g.id === bindings.get(request.handle) && g.owner === owner)
          if (!guest) {
            reply({ ok: false, error: 'guest not owned' })
            continue
          }
          if (request.method === 'Page.navigate') guest.url = request.params.url
          reply({ ok: true, result: { result: { value: 'https://example.com/' } } })
          continue
        }
        reply({ ok: true })
      }
    })
  })
  server.requests = requests
  server.guests = guests
  return server
}

/** Run the acceptance script against a fake and return its exit code. */
async function runAgainst (broken) {
  const server = makeBridge(broken)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = mkdtempSync(join(tmpdir(), 'accept-'))
  const endpoint = join(dir, 'endpoint.json')
  writeFileSync(endpoint, JSON.stringify({ pid: process.pid, port, token: 'fake-token' }))
  const child = spawn(process.execPath, ['tools/accept-desktop.mjs'], {
    env: { ...process.env, DSH_BRIDGE_ENDPOINT: endpoint, DSH_ACCEPT_SESSION: 'session-acceptance', DSH_ACCEPT_OTHER_SESSION: 'session-other', NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const code = await new Promise(resolve => child.on('exit', resolve))
  server.close()
  rmSync(dir, { recursive: true, force: true })
  return { code, out, requests: server.requests, guests: server.guests }
}

test('the acceptance script passes against a correct bridge', async () => {
  const { code, out } = await runAgainst('')
  assert.equal(code, 0, 'it should pass:\n' + out)
  assert.match(out, /ALL 11 CHECKS PASS/)
})

test('the acceptance script FAILS when newTab reuses an existing page', async () => {
  const { code, out } = await runAgainst('reuse')
  assert.notEqual(code, 0, 'a bridge that reuses must not be reported as working:\n' + out)
  // And it must say WHY. A run that prints only FAIL costs another restart to interpret, and the
  // restart is the scarce resource.
  assert.match(out, /\[diag\]/, 'a failure must carry state, not just a verdict:\n' + out)
  assert.match(out, /\[diag\] strip/, 'including what the tab strip actually holds')
})

test('the acceptance script FAILS when extra pages appear', async () => {
  const { code, out } = await runAgainst('spray')
  assert.notEqual(code, 0, 'a bridge that sprays tabs must not be reported as working:\n' + out)
})

test('the acceptance script FAILS when sidebar initialization is refused', async () => {
  const { code, out } = await runAgainst('refuse')
  assert.notEqual(code, 0, out)
  assert.match(out, /\[diag\]/)
})

test('pre-existing pages are never navigated or closed, even when any ensureSidebar call reuses them', async () => {
  for (const stage of ['first', 'second', 'other', 'reopen']) {
    const { code, out, requests, guests } = await runAgainst('protected-' + stage)
    assert.notEqual(code, 0, out)
    assert.match(out, /FAIL ensureSidebar reused pre-existing page/)
    assert.ok(requests.filter(r => r.op === 'ensureSidebar').every(r => r.url === undefined), 'identity must be checked before navigation')
    assert.deepEqual(requests.filter(r => ['cdp', 'closePage'].includes(r.op) && ['page:90', 'page:91'].includes(readTabHandle(r.handle).tab)), [], 'no mutations or cleanup may target protected pages')
    assert.deepEqual(guests.map(g => [g.id, g.url]), [[90, 'https://user.example/'], [91, 'https://other.example/']], 'only test-owned pages are cleaned up on failure')
  }
})

test('the acceptance script does not open pages when the initial inventory fails', async () => {
  const { code, out, requests } = await runAgainst('list-error')
  assert.notEqual(code, 0, out)
  assert.match(out, /cannot identify pre-existing pages/)
  assert.deepEqual(requests.filter(r => ['ensureSidebar', 'cdp', 'closePage'].includes(r.op)), [])
})

test('the acceptance CLI is included in the published package and the export fixup', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.ok(JSON.parse(read('../package.json')).files.includes('tools/accept-desktop.mjs'))
  assert.match(read('../scripts/fix-exports.mjs'), /'tools\/accept-desktop\.mjs'/)
})
