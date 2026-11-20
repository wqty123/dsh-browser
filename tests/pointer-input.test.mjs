import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'

/** Record native browser input separately from fixed viewport inspection. */
async function recordingProvider(onMouse = async () => {}) {
  const commands = []
  const presentations = []
  const view = {
    id: 'pointer-view',
    async sendCommand(method, params) {
      commands.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { value: { width: 500, height: 400 } } }
      if (method === 'Input.dispatchMouseEvent') await onMouse(params)
      return {}
    },
  }
  const host = {
    createView: () => view,
    destroyView() {},
    showView() {},
    async presentView(_view, _label, options) { presentations.push(options) },
  }
  const provider = new ElectronBrowserProvider(host, {
    settings: () => ({ ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, quiet: true } }),
    history: { enabled: false },
  })
  const session = await provider.open('pointer-input-regression')
  return {
    provider, session, commands, presentations,
    mouse: () => commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.params),
  }
}

const drag = {
  operation: 'drag',
  from: { x: 10, y: 20 },
  to: { x: 130, y: 80 },
  steps: 4,
}

test('native drag holds the mouse through the destination and carries quiet presentation', async () => {
  const check = await recordingProvider()
  const result = await check.provider.pageOperation(check.session, drag)
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(result.value).ok, true)
  const mouse = check.mouse()
  assert.deepEqual(mouse.map(event => event.type), [
    'mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved',
    'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased',
  ])
  assert.equal(mouse[0].buttons, 0)
  assert.equal(mouse[1].button, 'left')
  for (const event of mouse.slice(2, -1)) assert.equal(event.buttons, 1)
  assert.deepEqual(mouse.at(-1), {
    type: 'mouseReleased', x: 130, y: 80, button: 'left', buttons: 0, clickCount: 1,
  })
  assert.deepEqual(check.presentations, [{ quiet: true }])
  assert.equal(check.commands.some(command => String(command.params.expression).includes('dispatchEvent')), false)
})

test('hover sends one browser pointer move without a mouse press', async () => {
  const check = await recordingProvider()
  const result = await check.provider.pageOperation(check.session, {
    operation: 'probe', method: 'hoverAt', args: [120, 140],
  })
  assert.equal(result.ok, true)
  assert.equal(result.value, 'true')
  assert.deepEqual(check.mouse(), [{ type: 'mouseMoved', x: 120, y: 140, buttons: 0 }])
  assert.deepEqual(check.presentations, [{ quiet: true }])
})

test('cancellation during a held drag releases the original pointer before rejecting', async () => {
  const controller = new AbortController()
  const reason = new Error('cancel pointer gesture')
  const check = await recordingProvider(async event => {
    if (event.type === 'mouseMoved' && event.buttons === 1) controller.abort(reason)
  })
  await assert.rejects(
    check.provider.pageOperation(check.session, drag, controller.signal),
    error => error === reason,
  )
  const mouse = check.mouse()
  assert.equal(mouse.filter(event => event.type === 'mousePressed').length, 1)
  assert.deepEqual(mouse.at(-1), {
    type: 'mouseReleased', x: 40, y: 35, button: 'left', buttons: 0, clickCount: 1,
  })
})

test('invalid pointer coordinates fail before presentation or input', async () => {
  for (const x of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const check = await recordingProvider()
    await assert.rejects(
      check.provider.pageOperation(check.session, { ...drag, from: { x, y: 20 } }),
      error => error.code === 'BROWSER_POINTER_INVALID',
    )
    assert.deepEqual(check.presentations, [])
    assert.deepEqual(check.commands, [])
  }
})

test('out-of-viewport drag reports failure without pressing the mouse', async () => {
  const check = await recordingProvider()
  const result = await check.provider.pageOperation(check.session, {
    ...drag, to: { x: 500, y: 80 },
  })
  assert.equal(JSON.parse(result.value).ok, false)
  assert.deepEqual(check.mouse(), [])
})
