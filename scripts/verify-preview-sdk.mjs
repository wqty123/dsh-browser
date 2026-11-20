import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pairedRoute } from '../lib/browser-electron/authenticated-route.js'
import { handlePreviewFrame, handlePreviewSessions, PREVIEW_ROUTE, PREVIEW_SESSIONS_ROUTE } from '../lib/browser-electron/preview-route.js'

const sdk = process.argv[2]
assert.ok(sdk, 'usage: node scripts/verify-preview-sdk.mjs <published-SDK-install-directory>')
const require = createRequire(resolve(sdk, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const version = async name => JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8')).version
const connectionVersion = await version('@deepseek-ai/dsh-client-connection')
const cordisVersion = await version('@deepseek-ai/cordis')
const { Context } = await load('@deepseek-ai/cordis')
const { apply } = await load('@deepseek-ai/dsh-client-connection')
const ctx = new Context()
let record
ctx.provide('credentials', {
  async modifyRecord(_key, modify) {
    record = await modify(record) ?? record
    return record
  },
})
let captures = 0
let lists = 0
const browser = {
  exists: session => session === 'visible-session',
  watchableSessions() { lists++; return ['visible-session'] },
  async capturePassive() { captures++; return { dataUrl: 'data:image/png;base64,aW1hZ2U=' } },
}
const settings = { get: () => ({ remoteView: { enabled: true } }) }
const preview = pairedRoute(() => ctx.get('connection'), (request, response) => {
  return request.url.startsWith(PREVIEW_SESSIONS_ROUTE)
    ? handlePreviewSessions(request, response, settings, browser)
    : handlePreviewFrame(request, response, settings, browser)
})
let connection
const server = createServer((request, response) => {
  if (request.url.startsWith('/?')) {
    if (connection.authorizeIndex(request, response)) response.end('index')
  } else {
    Promise.resolve(preview(request, response)).catch(error => {
      response.writeHead(500)
      response.end(String(error))
    })
  }
})
try {
  await apply(ctx)
  connection = ctx.get('connection')
  assert.equal(typeof connection?.requestRejection, 'function')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const paths = [PREVIEW_SESSIONS_ROUTE, PREVIEW_ROUTE + '?session=visible-session']
  for (const path of paths) {
    const response = await fetch(base + path, { headers: { origin: base } })
    assert.equal(response.status, 401)
    await response.text()
  }
  assert.deepEqual({ captures, lists }, { captures: 0, lists: 0 })
  const login = await fetch(connection.authenticatedUrl(base + '/'), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await login.text()
  const headers = { cookie, origin: base }
  const list = await fetch(base + paths[0], { headers })
  assert.equal(list.status, 200)
  assert.deepEqual((await list.json()).sessions, ['visible-session'])
  assert.equal(captures, 0)
  const frame = await fetch(base + paths[1], { headers })
  assert.equal(frame.status, 200)
  assert.equal(await frame.text(), 'image')
  const foreign = await fetch(base + paths[1], { headers: { cookie, origin: 'https://foreign.example' } })
  assert.equal(foreign.status, 403)
  await foreign.text()
  assert.deepEqual({ captures, lists }, { captures: 1, lists: 1 })
  await ctx.fiber.dispose()
  const revoked = await fetch(base + paths[1], { headers })
  assert.equal(revoked.status, 503)
  await revoked.text()
  assert.equal(captures, 1)
  console.log(`SDK @deepseek-ai/dsh-client-connection ${connectionVersion}, @deepseek-ai/cordis ${cordisVersion}`)
  console.log('PASS: unpaired 401; paired list 200 and frame 200; foreign origin 403; disposed host 503; passive captures 1')
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await ctx.fiber.dispose()
}
