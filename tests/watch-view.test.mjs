// The floating live-view panel, actually executed.
//
// Two baseline defects were reproduced against the unmodified bundle (see the audit report):
//   3. the open button always watched sessions[0], so a later-created conversation could not
//      be reached from the entry;
//   4. stop() only flipped a shared boolean, so a request already in flight painted a stale
//      frame after a reopen and scheduled a SECOND screenshot loop; two quick clicks did the same.
//
// This loads the real client.js into a VM with a minimal DOM and a deferred fetch transport.
// The transport never runs a timer, so "one loop" is countable as the number of pending
// timeouts, and frames are resolved by hand to control exactly when an old request returns.
// It does NOT claim a native Desktop / LAN viewing E2E; that belongs to the integration run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const FIRST = 'browser:first-created'
const LATEST = 'browser:current-conversation'

/** Let every microtask (including the img.onload queued by the src setter) settle. */
const tick = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function makeFixture(sessions = [FIRST, LATEST]) {
  const nodes = []
  const timers = new Map()
  const frames = []
  const requests = []
  const aborted = []
  let timerSerial = 0
  let objectSerial = 0
  let factory

  const makeNode = tag => {
    const listeners = new Map()
    let imageSrc
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      hidden: false,
      children: [],
      attributes: {},
      value: undefined,
      setAttribute(k, v) { node.attributes[k] = String(v) },
      getAttribute(k) { return node.attributes[k] ?? null },
      removeAttribute(k) { delete node.attributes[k] },
      appendChild(child) { node.children.push(child); child.parent = node; return child },
      insertBefore(child, before) {
        const at = node.children.indexOf(before)
        if (at === -1) node.children.unshift(child)
        else node.children.splice(at, 0, child)
        return child
      },
      addEventListener(name, fn) { listeners.set(name, fn) },
      removeEventListener(name) { listeners.delete(name) },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node) },
      dispatch(name) { listeners.get(name)?.({ type: name }) },
    }
    if (tag === 'img') {
      Object.defineProperty(node, 'src', {
        get: () => imageSrc,
        set: value => { imageSrc = value; queueMicrotask(() => node.onload?.()) },
      })
    }
    nodes.push(node)
    return node
  }

  const document = {
    body: makeNode('body'),
    head: makeNode('head'),
    documentElement: makeNode('html'),
    visibilityState: 'visible',
    getElementById() { return null },
    createElement: makeNode,
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
  }
  const reply = data => ({ ok: true, status: 200, json: async () => data })
  const fetch = (url, init) => {
    const path = String(url)
    requests.push({ path, init })
    if (path.endsWith('/sessions')) return Promise.resolve(reply({ enabled: true, sessions }))
    if (path.endsWith('/bridge-status')) return Promise.resolve(reply({ bridge: { state: 'installed', present: true } }))
    if (path.includes('/frame?')) {
      return new Promise(resolve => frames.push({ path, resolve: label => resolve({
        ok: true, status: 200, blob: async () => ({ label }),
      }) }))
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  }
  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; aborted.push(this) }
    abort() { this.signal.aborted = true }
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: spec => { factory = spec.factory } } },
    document, fetch, console, queueMicrotask, AbortController: FakeAbortController,
    URL: {
      createObjectURL: blob => `blob:${blob.label}:${++objectSerial}`,
      revokeObjectURL() {},
    },
    Date: { now: () => 10000 },
    setTimeout: fn => { const id = ++timerSerial; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(typeof factory, 'function', 'the bundle registered its ModuleLoader factory')
  const exports = factory(id => { if (id === 'react') return {}; throw new Error(`unexpected require: ${id}`) })
  exports.apply({
    locale: { register() {}, bind: () => key => key },
    effect: run => { const cleanup = run(); if (typeof cleanup === 'function') cleanup(); return () => {} },
    slots: { inject: (_name, run) => run(), register() {} },
  })
  const byClass = name => nodes.find(node => node.className === name)
  return {
    byClass, frames, timers, requests, aborted, document,
    get open() { return byClass('dsh-bw-watch-open') },
    get stopButton() { return byClass('dsh-bw-watch-stop') },
    get select() { return byClass('dsh-bw-watch-session') },
    get img() { return byClass('dsh-bw-watch-img') },
  }
}

const sessionOf = path => new URL(path, 'http://localhost').searchParams.get('session')

test('a single session keeps the original behaviour and hides the picker', async () => {
  const f = makeFixture([FIRST])
  await tick()
  f.open.dispatch('click')
  await tick()
  assert.equal(f.frames.length, 1, 'one frame request')
  assert.equal(sessionOf(f.frames[0].path), FIRST, 'the only session is still watched')
  assert.ok(f.select, 'the picker exists')
  assert.equal(f.select.hidden, true, 'and stays hidden when there is nothing to choose')
})

test('with several sessions the newest one is watched, not the first map entry', async () => {
  const f = makeFixture()
  await tick()
  f.open.dispatch('click')
  await tick()
  assert.equal(f.frames.length, 1)
  assert.equal(sessionOf(f.frames[0].path), LATEST,
    'sessions[0] must not be the automatic target when a later conversation exists')
  assert.equal(f.select.hidden, false, 'the choice is offered')
  assert.equal(f.select.children.length, 2, 'one option per session')
  assert.equal(f.select.value, LATEST)
})

test('switching sessions replaces the loop and drops the superseded frame', async () => {
  const f = makeFixture()
  await tick()
  f.open.dispatch('click')
  await tick()
  assert.equal(f.frames.length, 1)

  f.select.value = FIRST
  f.select.dispatch('change')
  await tick()
  assert.equal(f.frames.length, 2, 'the switch starts exactly one new run')
  assert.equal(sessionOf(f.frames[1].path), FIRST, 'and it watches the session the human chose')

  f.frames[0].resolve('stale-from-previous-session')
  await tick()
  assert.doesNotMatch(String(f.img.src ?? ''), /stale-from-previous-session/, 'the old run paints nothing')
  assert.equal(f.timers.size, 0, 'the old run schedules no timer')

  f.frames[1].resolve('fresh-from-chosen-session')
  await tick()
  assert.match(String(f.img.src ?? ''), /fresh-from-chosen-session/, 'the chosen session paints')
  assert.equal(f.timers.size, 1, 'exactly one loop remains')
})

test('stopping and reopening never paints a stale frame or leaves two loops', async () => {
  const f = makeFixture()
  await tick()
  f.open.dispatch('click')
  await tick()
  f.stopButton.dispatch('click')
  await tick()
  f.open.dispatch('click')
  await tick()
  assert.equal(f.frames.length, 2, 'a reopen issues one new request')

  f.frames[0].resolve('stale-before-stop')
  await tick()
  assert.doesNotMatch(String(f.img.src ?? ''), /stale-before-stop/, 'the stopped run cannot paint')
  assert.equal(f.timers.size, 0, 'and cannot resurrect a scheduling chain')

  f.frames[1].resolve('fresh-after-reopen')
  await tick()
  assert.match(String(f.img.src ?? ''), /fresh-after-reopen/, 'the reopened run paints')
  assert.equal(f.timers.size, 1, 'one viewer, one loop')
  assert.ok(f.aborted.some(controller => controller.signal.aborted), 'the in-flight request was aborted')
})

test('two clicks in one tick start only one frame request', async () => {
  const f = makeFixture()
  await tick()
  f.open.dispatch('click')
  f.open.dispatch('click')
  await tick()
  assert.equal(f.frames.length, 1, 'no second concurrent frame request')
})

test('the frame request carries an abort signal from the current run', async () => {
  const f = makeFixture()
  await tick()
  f.open.dispatch('click')
  await tick()
  const init = f.requests.find(entry => entry.path.includes('/frame?'))?.init
  assert.ok(init !== undefined, 'the request has an init object')
  assert.ok(init.signal !== undefined, 'and it can be cancelled on stop')
})
