import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'
import { guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'

test('live expandtesting login GET succeeds through the proxy before and after reloading the persisted jar', {
  skip: process.env.DSH_TEST_LIVE_LOGIN !== '1' && 'set DSH_TEST_LIVE_LOGIN=1 to contact the live login site', timeout: 60000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-login-')), errors = []
  let jar = loadGuestCookies(directory)
  const server = createServer((req, res) => {
    void handleGuest(req, res, '', '', jar).catch(error => { errors.push(error.name); res.destroy(error) })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  for (let restart = 0; restart < 2; restart++) {
    const result = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port,
        path: guestPath('https://practice.expandtesting.com/login') + '&storage-context=live-login-regression',
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'same-origin', 'upgrade-insecure-requests': '1' },
      }, async res => {
        try {
          let body = ''; for await (const chunk of res) body += chunk
          resolve({ status: res.statusCode, body, complete: res.complete })
        } catch (error) { reject(error) }
      })
      req.on('error', reject); req.end()
    })
    assert.equal(result.status, 200, result.body.match(/guest proxy: upstream[^<]*/u)?.[0])
    assert.equal(result.complete, true)
    assert.match(result.body, /<title>Test Login Page/u)
    assert.match(result.body, /id="username"/u)
    assert.match(result.body, /data-dsh-guest-runtime/u)
    jar = loadGuestCookies(directory)
    assert.ok(jar.getCookieHeader(new URL('https://practice.expandtesting.com/login')))
    console.log(`LIVE login GET: status=${result.status}; persistedJarReload=${restart > 0}; loginForm=true; identityRuntime=true`)
  }
  assert.deepEqual(errors, [])
})
