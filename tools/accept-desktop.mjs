#!/usr/bin/env node
/** Live, destructive sidebar checks. Supply two existing conversation IDs; only test pages are closed. */
import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const owner = process.env.DSH_ACCEPT_SESSION
const otherOwner = process.env.DSH_ACCEPT_OTHER_SESSION
if (!/^session-.+/.test(owner ?? '') || !/^session-.+/.test(otherOwner ?? '') || owner === otherOwner) {
  console.error('Set DSH_ACCEPT_SESSION and DSH_ACCEPT_OTHER_SESSION to two different existing session-… conversation IDs.')
  process.exit(1)
}
const endpoint = process.env.DSH_BRIDGE_ENDPOINT
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-builtin-browser-bridge.json')
const ep = JSON.parse(readFileSync(endpoint, 'utf8'))
const socket = connect({ host: '127.0.0.1', port: ep.port })
socket.setEncoding('utf8')
const pending = new Map(), results = [], opened = [], protectedIds = new Set()
let seq = 0, buffer = ''
socket.on('data', chunk => {
  buffer += chunk
  let cut
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 1)
    let answer
    try { answer = JSON.parse(line) } catch { continue }
    const waiter = pending.get(answer.bridgeRequestId)
    if (!waiter) continue
    clearTimeout(waiter.timer)
    pending.delete(answer.bridgeRequestId)
    waiter.resolve(answer)
  }
})
function disconnected(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  pending.clear()
}
socket.on('error', disconnected)
socket.on('close', () => disconnected(new Error('bridge disconnected')))
function call(op, extra = {}) {
  const bridgeRequestId = ++seq
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('bridge disconnected'))
    const timer = setTimeout(() => {
      pending.delete(bridgeRequestId)
      reject(new Error(`${op} timed out`))
    }, 30_000)
    pending.set(bridgeRequestId, { resolve, reject, timer })
    socket.write(JSON.stringify({ op, owner, bridgeRequestId, ...extra, ...seq === 1 ? { token: ep.token } : {} }) + '\n')
  })
}
async function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok' : 'FAIL'} ${name} ${detail}`)
  if (ok) return
  try {
    const state = await call('list')
    console.log('[diag] strip ' + JSON.stringify((state.sidebar ?? []).map(g => ({ id: g.id, title: g.title, url: g.url }))))
  } catch (error) { console.log('[diag] strip unavailable: ' + error.message) }
}
async function open(session, viewId, url) {
  const answer = await call('ensureSidebar', { owner: session, viewId, url })
  if (answer.ok === true && Number.isSafeInteger(answer.id) && !protectedIds.has(answer.id)) opened.push({ owner: session, id: answer.id })
  return answer
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('bridge connect timed out')) }, 5_000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  const version = await call('version')
  await check('the current bridge build is loaded', version.ok === true && version.protocol >= 3
    && Date.parse(version.loadedAt) >= statSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url)).mtimeMs)
  const before = (await call('list')).sidebar ?? []
  const otherInitial = (await call('list', { owner: otherOwner })).sidebar ?? []
  for (const page of [...before, ...otherInitial]) protectedIds.add(page.id)
  const prefix = 'accept-' + randomUUID()
  const firstView = prefix + '-first', secondView = prefix + '-second'
  const first = await open(owner, firstView, 'https://example.com/')
  await check('first open returns a page', first.ok === true && Number.isSafeInteger(first.id))
  const second = await open(owner, secondView, 'https://example.org/')
  await check('second logical view creates a DIFFERENT page', second.ok === true && Number.isSafeInteger(second.id) && second.id !== first.id)
  const pages = (await call('list')).sidebar ?? []
  await check('exactly two pages were added — no spray', pages.length - before.length === 2)
  let operable = 0
  for (const [id, logicalViewId] of [[first.id, firstView], [second.id, secondView]]) {
    const shown = await call('showTab', { viewId: id, logicalViewId })
    const answer = await call('cdp', { id, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } })
    if (shown.ok === true && answer.ok === true && typeof answer.result?.result?.value === 'string' && answer.result.result.value !== '') operable += 1
  }
  await check('both pages answer after being brought forward', operable === 2)
  const otherBefore = (await call('list', { owner: otherOwner })).sidebar ?? []
  await check('another session cannot see these pages', otherBefore.every(g => g.id !== first.id && g.id !== second.id))
  const other = await open(otherOwner, prefix + '-other', 'https://example.net/')
  await check('two sessions get DIFFERENT pages', other.ok === true && Number.isSafeInteger(other.id) && other.id !== first.id && other.id !== second.id)
  const mine = (await call('list')).sidebar ?? []
  const theirs = (await call('list', { owner: otherOwner })).sidebar ?? []
  await check('neither can see the other’s page', mine.some(g => g.id === first.id) && theirs.some(g => g.id === other.id)
    && !mine.some(g => g.id === other.id) && theirs.every(g => g.id !== first.id && g.id !== second.id))
  const reopened = await call('ensureSidebar', { viewId: firstView, guestId: first.id, url: 'https://example.com/' })
  await check('reopening a logical view reuses its page', reopened.ok === true && reopened.id === first.id)
  const closed = await call('closePage', { id: second.id })
  const remaining = (await call('list')).sidebar ?? []
  await check('closing one page actually closes it', closed.ok === true && closed.closed === 1 && remaining.every(g => g.id !== second.id))
  await check('the other page survives', remaining.some(g => g.id === first.id))
  const failed = results.filter(r => !r.ok)
  console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASS` : `${failed.length} of ${results.length} FAILED`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  console.error('[diag] ' + error.message)
  process.exitCode = 1
} finally {
  for (const page of opened) {
    try { await call('closePage', page) } catch { /* best effort */ }
  }
  socket.destroy()
}
