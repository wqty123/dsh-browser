// Three message/semantics defects a reporter found on DSH Desktop 2.0.17, all of the same kind:
// the behaviour was right, what it SAID was wrong. None of them broke a function, which is exactly
// why each survived a round of testing that only checked whether things worked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const bridge = read('../desktop-bridge/plugin-browser-bridge.js')
const entry = read('../src/browser-electron/entry.ts')
const host = read('../src/browser-electron/desktop-bridge-host.ts')
const types = read('../src/browser/types.ts')

test('the fallback says WHICH loss happened, not always an exiting shell', () => {
  // Reported: a fallback caused by an undrivable sidebar panel logged
  //   "the desktop shell backed the sidebar browser and has exited"
  // while the shell was alive and answering. The user had no way to know their desktop had not
  // crashed, and the reporter's own words for it were that this inverts the reason.
  assert.match(types, /export type CarrierLossReason = 'shell-exited' \| 'panel-unusable'/,
    'the two reasons are named')
  assert.match(entry, /reason: CarrierLossReason/, 'the fallback takes the reason')
  assert.match(entry, /reason === 'shell-exited'\s*\n?\s*\?/, 'and branches on it')
  assert.match(entry, /the desktop shell backed the sidebar browser and has exited/, 'keeping the exiting-shell wording')
  assert.match(entry, /renders the sidebar browser panel in a way that\s*\n?\s*'?\s*\+?\s*'?cannot be driven/,
    'and a wording that says the shell is still running')
  // The transport can only ever conclude one thing, and it must still say the right one.
  assert.match(host, /reportLost\('shell-exited'\)/, 'the transport reports an exiting shell')
  assert.match(host, /reportLost\('panel-unusable'\)/, 'the panel failure reports an unusable panel')
})

test('the reason travels from the host through the interface to the entry point', () => {
  // A reason that stops at the host is decoration. All three hops are asserted because dropping any
  // one of them silently restores the old behaviour: the listener would be called with no reason.
  assert.match(host, /onLost\(listener: \(reason: CarrierLossReason\) => void\): void \{/, 'the host accepts it')
  assert.match(host, /this\.lostListener\?\.\(reason\)/, 'and forwards it')
  assert.match(read('../src/browser-electron/provider.ts'), /onLost\?\(listener: \(reason: CarrierLossReason\) => void\): void/,
    'the interface declares it')
  assert.match(entry, /host\.onLost\?\.\(reason => \{ restoreSelfHosted\(host, reason\) \}\)/, 'and entry uses it')
})

test('the fallback does not replace its own explanation with a connection error', () => {
  // Reported: the first call after an iframe panel was adopted returned
  //   "dsh-builtin-browser: bridge closed"
  // instead of the designed "... sidebar unavailable (... produced no page ...)". Disposing the
  // adopted carrier synchronously closes the bridge socket while the request that triggered this
  // fallback is still settling, and the close rejects every call waiting on it — so the reason the
  // user needed was overwritten by one about the connection, on the very path whose purpose is to
  // explain what happened.
  const fn = entry.slice(entry.indexOf('const restoreSelfHosted ='))
  const body = fn.slice(0, fn.indexOf('\n  }'))
  assert.match(body, /setImmediate\(/, 'disposal is deferred to a later turn')
  assert.match(body, /adopted\.dispose\?\.\(\)/, 'and still happens')
  // The synchronous form must be gone: a `finally { adopted.dispose?.() }` right after the try is
  // the exact shape that caused the report.
  const finallyBlock = body.slice(body.indexOf('} finally {'))
  assert.doesNotMatch(finallyBlock.slice(0, finallyBlock.indexOf('})') + 2), /adopted\.dispose\?\.\(\)\s*\n\s*\}\)/,
    'not disposed synchronously inside finally')
})

test('startedAt records when the bridge started, not when it last said hello', () => {
  // Reported: two reads 15 seconds apart differed by exactly 15 seconds with the port unchanged,
  // which read as "the bridge restarted". `publishEndpoint` runs on every keepalive, so refreshing
  // the field there made it mean the last keepalive — the one thing a reader does not want from a
  // field called startedAt.
  assert.match(bridge, /function publishEndpoint\(port, token\)/, 'the publisher exists')
  const fn = bridge.slice(bridge.indexOf('function publishEndpoint(port, token)'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /startedAt: instanceStartedAt\(\)/, 'startedAt comes from the instance')
  assert.doesNotMatch(body, /startedAt: new Date\(\)\.toISOString\(\)/, 'not from the current time')
  assert.match(body, /updatedAt: new Date\(\)\.toISOString\(\)/, 'while updatedAt still tracks the keepalive')
  // Recorded once per module evaluation, which is one bridge instance: a real restart IS reported.
  assert.match(bridge, /const instanceStartedAt = \(\(\) => \{/, 'an instance-scoped constant')
  assert.match(bridge, /const at = new Date\(\)\.toISOString\(\)\n\s*return \(\) => at/, 'captured once and returned')
})
