import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createAutomaticMaintenanceHandler } from '../lib/browser-electron/maintenance-route.js'

const job = { id: 'install-fixture', action: 'install', phase: 'armed', at: new Date().toISOString() }
function fixture(overrides = {}) {
  const calls = []
  const handler = createAutomaticMaintenanceHandler({ supported: () => true, read: () => undefined,
    start: async action => { calls.push(action); return { ...job, action } }, ...overrides })
  const request = async (options = {}) => {
    const req = Readable.from([options.body ?? '{"action":"install"}'])
    req.method = options.method ?? 'POST'
    req.headers = { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', ...options.headers }
    req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
    const res = Object.assign(new EventEmitter(), { statusCode: 0, setHeader() {},
      writeHead(code) { this.statusCode = code }, end(text) { this.body = JSON.parse(text); this.emit('finish') } })
    await handler(req, res)
    return res
  }
  return { request, calls }
}
test('maintenance protocol starts only an explicit valid local POST and returns accepted, never installed', async () => {
  const f = fixture()
  const r = await f.request()
  assert.equal(r.statusCode, 202)
  assert.equal(r.body.protocol, 1)
  assert.equal(r.body.accepted, true)
  assert.equal(r.body.job.phase, 'armed')
  assert.deepEqual(f.calls, ['install'])
})
test('status reads do not start maintenance and retain the durable last outcome', async () => {
  const last = { ...job, phase: 'completed', ok: true, restarted: true }
  const f = fixture({ read: () => last })
  const r = await f.request({ method: 'GET' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.body.job, last)
  assert.deepEqual(f.calls, [])
})
test('remote, forwarded, and foreign-origin requests cannot start maintenance', async () => {
  for (const options of [{ remoteAddress: '192.168.1.8' }, { headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { origin: 'https://untrusted.invalid' } }]) {
    const f = fixture()
    assert.equal((await f.request(options)).statusCode, 403)
    assert.deepEqual(f.calls, [])
  }
})
test('invalid bodies and unsupported methods never reach the worker', async () => {
  for (const options of [{ body: '{}' }, { body: 'null' }, { body: 'bad JSON' }, { body: 'x'.repeat(5000) }, { method: 'DELETE' }]) {
    const f = fixture()
    assert.ok([400, 405].includes((await f.request(options)).statusCode))
    assert.deepEqual(f.calls, [])
  }
})
test('worker startup failure is reported without claiming completion', async () => {
  const f = fixture({ start: async () => { throw new Error('broker could not arm') } })
  const r = await f.request()
  assert.equal(r.statusCode, 409)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /could not arm/)
})
test('unsupported platforms cannot begin maintenance', async () => {
  const f = fixture({ supported: () => false })
  assert.equal((await f.request()).statusCode, 409)
  assert.deepEqual(f.calls, [])
})
test('worker commit happens only after the accepted response is finished', async () => {
  let committed
  const f = fixture({ commit: async id => { committed = id } })
  const r = await f.request()
  assert.equal(r.statusCode, 202)
  assert.equal(committed, job.id)
})

test('the progress language follows the explicit supported interface locale', async () => {
  for (const locale of ['zh', 'en']) {
    let supplied
    const f = fixture({ start: async (action, options) => { supplied = options; return { ...job, action } } })
    const r = await f.request({ body: JSON.stringify({ action: 'install', locale }) })
    assert.equal(r.statusCode, 202)
    assert.deepEqual(supplied, { locale })
  }
})

test('unsupported progress language is rejected without starting a worker', async () => {
  const f = fixture()
  const r = await f.request({ body: '{"action":"install","locale":"unexpected"}' })
  assert.equal(r.statusCode, 400)
  assert.deepEqual(f.calls, [])
})
