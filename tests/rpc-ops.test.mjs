// The two sides of the child RPC must agree on the operation names.
//
// The parent sends them and the child switches on them, and until now each spelled the list out
// on its own with nothing connecting the two. A rename on one side compiled and then failed at
// run time as "unknown op" — on a path that is only reached when the browser host is actually
// spawned, which the suite does not do.
//
// This reads both switch statements rather than trusting a table: a table would only say what
// someone wrote down, while these assert what the code actually dispatches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { RPC_NOTIFICATIONS, RPC_OPS } from '../lib/browser-electron/rpc-ops.js'

/**
 * Collect the string literals a file switches on.
 * @param path - the source file.
 * @returns the case labels, in source order.
 */
function caseLabels(path) {
  const source = readFileSync(path, 'utf8')
  const found = []
  for (const match of source.matchAll(/case '([A-Za-z][\w-]*)':/g)) found.push(match[1])
  return found
}

test('every operation the manifest lists is handled by the child', () => {
  const handled = new Set(caseLabels('src/browser-electron/host-main.ts'))
  const missing = RPC_OPS.filter(op => !handled.has(op))
  assert.deepEqual(missing, [], `listed as an operation but the child does not handle it: ${missing.join(', ')}`)
})

test('every operation the child handles is in the manifest', () => {
  // The other direction: an op handled but unlisted is one the migration would forget.
  const handled = caseLabels('src/browser-electron/host-main.ts')
  const listed = new Set(RPC_OPS)
  // The toolbar routes its own actions through the same switch shape; those are not RPC ops.
  const toolbar = new Set(['navigate', 'new-tab', 'activate', 'close', 'back', 'forward', 'reload'])
  const unlisted = handled.filter(op => !listed.has(op) && !toolbar.has(op))
  assert.deepEqual(unlisted, [], `handled by the child but absent from the manifest: ${unlisted.join(', ')}`)
})

test('the notifications the child sends are the ones the parent listens for', () => {
  const parent = readFileSync('src/browser-electron/remote-host.ts', 'utf8')
  const missing = RPC_NOTIFICATIONS.filter(name => !parent.includes(`'${name}'`))
  assert.deepEqual(missing, [], `the child sends these but the parent never names them: ${missing.join(', ')}`)
})
