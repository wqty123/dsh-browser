// Readiness: the answer to "can this browser serve a call right now".
//
// The defect this closes is a UX one with a long tail: the bundled runtime downloads on first need
// (issue #41 moved it out of `postinstall`, correctly), so on a fresh install the first browser call
// can fail while the download is still running — and the only trace was a log line the settings
// panel cannot read. These tests pin the report the panel renders, one carrier at a time, because
// "ready" is a property of the CARRIER and getting that wrong is how a panel ends up green while
// nothing works.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { readRuntimeStatus } from '../lib/browser-electron/runtime-status.js'

const at = '2026-11-03T15:00:00.000Z'

/** A provisioning state, in the shape the machine reports it. */
function provision(state, detail = `${state} detail`) {
  return { state, detail, at }
}

/** No desktop install at all — the `dsh web` case. */
const noDesktop = () => undefined

/** A desktop install whose bridge is in the given state. */
const bridge = (state, command) => () => ({
  state,
  present: true,
  archivePresent: false,
  detail: `${state} detail`,
  ...command === undefined ? {} : { command },
})

/** Nothing published an endpoint — the shell is installed but closed. */
const noShell = () => undefined

/** A running shell on some pid. */
const shellRunning = () => ({
  present: true,
  alive: true,
  detail: 'a desktop shell is running and answering on its published endpoint',
  updatedAt: '2026-11-03T15:00:00.000Z',
})

/** One report, with the readers a test does not care about defaulted to "nothing installed". */
function report(channel, {
  binary = false,
  provisioning = provision('idle'),
  bridgeReader = noDesktop,
  endpointReader = noShell,
} = {}) {
  return readRuntimeStatus({
    channel: () => channel,
    hasBinary: () => binary,
    provision: () => provisioning,
    bridge: bridgeReader,
    endpoint: endpointReader,
  })
}

test('the bundled carrier with a runtime on disk is ready, and offers no button', () => {
  const status = report('bundled', { binary: true })
  assert.equal(status.carrier, 'bundled')
  assert.equal(status.readiness, 'ready')
  assert.equal(status.electron.state, 'present', 'the binary on disk outranks what the machine last said')
  assert.match(status.electron.detail, /already available/,
    'and the sentence agrees with the state — "present" next to "not been asked for yet" was measured on a live install')
  assert.equal(status.canProvision, false, 'nothing to prepare')
})

test('a download in progress is reported as such, and is not restarted by the button', () => {
  const status = report('bundled', { provisioning: provision('preparing', 'downloading Electron 44.10.0') })
  assert.equal(status.readiness, 'blocked')
  assert.equal(status.electron.state, 'preparing')
  assert.equal(status.electron.detail, 'downloading Electron 44.10.0', 'the reason travels with the state')
  assert.equal(status.canProvision, false, 'a second download into one directory is the one thing to refuse')
})

test('a failed preparation is blocked AND offers the retry', () => {
  const status = report('bundled', { provisioning: provision('failed', 'the download failed: fetch failed') })
  assert.equal(status.readiness, 'blocked')
  assert.equal(status.canProvision, true, 'this is the state the retry button exists for')
  assert.match(status.electron.detail, /fetch failed/)
})

test('the sidebar carrier is ready when the bridge is installed AND the shell is running', () => {
  const status = report('sidebar', {
    bridgeReader: bridge('installed', 'node install.mjs "C:/app" --restart'),
    endpointReader: shellRunning,
  })
  assert.equal(status.carrier, 'sidebar')
  assert.equal(status.readiness, 'ready')
  assert.equal(status.bridge.state, 'installed')
  assert.equal(status.bridge.present, true)
  assert.equal(status.bridge.running, true)
})

test('an installed bridge with no running shell is NOT ready', () => {
  // The most common broken state there is: the desktop app is simply closed. The install tree still
  // says installed, the endpoint file is stale or gone, and every call would dial a dead port.
  const status = report('sidebar', { bridgeReader: bridge('installed', 'node install.mjs "C:/app" --restart') })
  assert.equal(status.bridge.state, 'installed', 'the tree is still patched')
  assert.equal(status.bridge.running, false, 'but nothing is answering')
  assert.equal(status.readiness, 'blocked', 'so the carrier is not ready')
  assert.match(status.bridge.runningDetail, /no desktop shell/, 'and the panel can say why')
})

test('the sidebar carrier on a machine with no desktop says so instead of asking for a repair', () => {
  const status = report('sidebar')
  assert.equal(status.readiness, 'blocked')
  assert.equal(status.bridge.state, 'absent', 'nothing to repair is a different state from something to repair')
  assert.equal(status.bridge.present, false)
  assert.equal(status.bridge.command, undefined, 'and there is no command to run')
})

test('a stale bridge keeps its repair command', () => {
  const command = 'node install.mjs "C:/DSH Desktop" --restart'
  const status = report('sidebar', { bridgeReader: bridge('stale', command) })
  assert.equal(status.readiness, 'blocked')
  assert.equal(status.bridge.state, 'stale')
  assert.equal(status.bridge.command, command, 'shown to be run by a human, never run by the plugin')
})

test('automatic is satisfied by either carrier, but only by a RUNNING one', () => {
  const viaBridge = report('auto', { bridgeReader: bridge('installed'), endpointReader: shellRunning })
  assert.equal(viaBridge.readiness, 'ready')
  const viaRuntime = report('auto', { binary: true })
  assert.equal(viaRuntime.readiness, 'ready')
  const installedButClosed = report('auto', { bridgeReader: bridge('installed') })
  assert.equal(installedButClosed.readiness, 'unknown', 'a closed desktop is not a working carrier')
})

test('automatic with neither says it cannot tell rather than showing red', () => {
  const status = report('auto', { provisioning: provision('failed') })
  assert.equal(status.readiness, 'unknown', 'an installed Chrome/Edge could still satisfy it, and this must not launch one to find out')
})

test('an explicit Chrome/Edge choice is never guessed at', () => {
  const status = report('chrome', { provisioning: provision('failed') })
  assert.equal(status.carrier, 'system')
  assert.equal(status.readiness, 'unknown')
  assert.equal(status.canProvision, true, 'the bundled runtime is still offerable as a way out')
})

test('a runtime installed by hand after a failure is reported ready without a restart', () => {
  // The binary probe wins over the last provisioning result on purpose: the runtime can appear by
  // another route (a manual install, another process, ELECTRON_PATH) and a panel that kept saying
  // "failed" while a launch would succeed is the sort of stale state that sends people hunting.
  const status = report('bundled', { binary: true, provisioning: provision('failed', 'the download failed') })
  assert.equal(status.electron.state, 'present')
  assert.equal(status.readiness, 'ready')
})

test('the state vocabulary the panel localizes matches what the host can emit', () => {
  // The panel renders `readiness.electron.<state>` and friends as template literals, which the
  // locale-parity test cannot see. A state with no label would render as a raw key, so the closed
  // sets are pinned here and checked against the host's own declarations.
  const source = readFileSync(new URL('../src/browser-electron/runtime-status.ts', import.meta.url), 'utf8')
  const provisionSource = readFileSync(new URL('../src/browser-electron/electron-provision.ts', import.meta.url), 'utf8')
  const snapshot = /state: 'idle' \| 'preparing' \| 'present' \| 'ready' \| 'skipped' \| 'failed'/.test(provisionSource)
  assert.ok(snapshot, 'the provisioning state union is the one this test enumerates')
  const readiness = /export type Readiness = 'ready' \| 'blocked' \| 'unknown'/.test(source)
  assert.ok(readiness, 'and so is the readiness union')
  const carrier = /export type CarrierKind = 'sidebar' \| 'bundled' \| 'system' \| 'auto'/.test(source)
  assert.ok(carrier, 'and the carrier union')
})

test('every state and carrier the report can name has a label in both languages', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const zhBlock = client.slice(client.indexOf('const zh = {'), client.indexOf('const en = {'))
  const enBlock = client.slice(client.indexOf('const en = {'), client.indexOf('async function callSettings'))
  const has = (block, key) => new RegExp(`"${key.replace(/\./g, '\\.')}":`).test(block)
  const keys = []
  for (const state of ['idle', 'preparing', 'present', 'ready', 'skipped', 'failed']) keys.push(`readiness.electron.${state}`)
  // Two rows beyond the install-tree states: the panel distinguishes an installed bridge that is
  // running from one whose desktop app is closed, in both directions.
  for (const state of ['installed', 'installedRunning', 'installedNotRunning', 'missing', 'stale', 'absent']) keys.push(`readiness.bridge.${state}`)
  for (const carrier of ['sidebar', 'bundled', 'system', 'auto']) {
    keys.push(`readiness.carrier.${carrier}`)
    keys.push(`readiness.hint.${carrier}`)
  }
  for (const readiness of ['ready', 'blocked', 'unknown']) keys.push(`readiness.state.${readiness}`)
  const missing = keys.filter(key => !has(zhBlock, key) || !has(enBlock, key))
  assert.deepEqual(missing, [], 'these would render as raw keys in the panel')
})
