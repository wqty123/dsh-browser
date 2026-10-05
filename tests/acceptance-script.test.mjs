// Prove the acceptance script can FAIL, not just pass.
//
// `tools/accept-desktop.mjs` is what a restart gets spent on. A checker that always reports
// success would waste that restart in the worst way — it would look like the work was done. So
// the script is run three times here against fake bridges: one correct, one that reuses a page
// instead of opening one (this session's first bug), one that opens extra pages (this session's
// fifth). The correct one must pass; the other two must fail.
import { createServer } from 'node:net'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** A fake bridge that answers the ops the acceptance script uses. */
function makeBridge (broken = '') {
  const guests = []
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
        const reply = (body) => socket.write(JSON.stringify({ ...body, bridgeRequestId: request.bridgeRequestId }) + '\n')
        const owner = request.owner ?? 'anonymous'

        if (request.op === 'list') {
          const mine = guests.filter(g => g.owner === owner)
          // The shell window travels with every list answer, which is what lets a FAILING run read
          // the tab strip back and say what it saw instead of just "FAIL".
          const shell = { id: 1, url: 'dsh-app://app/', title: 'shell', type: 'window' }
          reply({ ok: true, guests: [shell, ...mine], sidebar: mine.map(g => ({ id: g.id, url: g.url, title: g.title, type: 'webview' })) })
          continue
        }
        if (request.op === 'ensureSidebar') {
          if (request.newTab === true && broken === 'reuse') {
            reply({ ok: true, created: false, id: guests[0]?.id, owner, reused: true })
            continue
          }
          const id = nextId++
          guests.push({ id, url: 'about:blank', title: 'page ' + id, owner })
          if (broken === 'spray') {
            const extra = nextId++
            guests.push({ id: extra, url: 'about:blank', title: 'page ' + extra, owner })
          }
          reply({ ok: true, created: true, id, owner })
          continue
        }
        if (request.op === 'showTab') { reply({ ok: true, verdict: 'CLICKED' }); continue }
        if (request.op === 'closeSidebarBrowser') {
          // Actually close: the acceptance script checks the OUTCOME, so a fake that only
          // pretends would make the close checks meaningless. Only this owner's guests, matching
          // the bridge's rule, and only those the titles select.
          const wanted = Array.isArray(request.titles) ? request.titles : undefined
          let closed = 0
          for (let i = guests.length - 1; i >= 0; i--) {
            const guest = guests[i]
            if (guest.owner !== owner) continue
            if (wanted !== undefined && !wanted.some(w => String(guest.title).startsWith(w))) continue
            guests.splice(i, 1)
            closed += 1
          }
          reply({ ok: true, closed })
          continue
        }
        if (request.op === 'cdp') {
          const expression = String(request.params?.expression ?? '')
          reply({ ok: true, result: { result: { value: expression.includes('settings') ? '200' : 'https://example.com/' } } })
          continue
        }
        reply({ ok: true })
      }
    })
  })
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
    env: { ...process.env, DSH_BRIDGE_ENDPOINT: endpoint },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const code = await new Promise(resolve => child.on('exit', resolve))
  server.close()
  return { code, out }
}

test('the acceptance script passes against a correct bridge', async () => {
  const { code, out } = await runAgainst('')
  assert.equal(code, 0, 'it should pass:\n' + out)
  assert.match(out, /ALL 10 CHECKS PASS/)
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
