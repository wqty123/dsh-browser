// Regression for issue #16: a failed toolbar action must never be able to take
// the whole DSH host down.
//
// Two independent shapes were reported, and both are covered here:
//   1. the provider read the host's method off its owner and called it unbound,
//      so the host ran with `this === undefined` and threw at its first statement
//      (`void this.ready()`);
//   2. even correctly bound, `ready()` threw SYNCHRONOUSLY once the host had been
//      disposed — a synchronous throw escapes a fire-and-forget caller's
//      `.catch`, which is what turned a diagnostics path into a fatal error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

/** The exact receiver-dependent stub the issue's repro used. */
function makeHost() {
  const handlers = {}
  let notifyCalls = 0
  return {
    handlers,
    get notifyCalls() { return notifyCalls },
    createView() {
      return { id: 'v1', sendCommand: async () => ({}) }
    },
    onUserAction(handler) { handlers.userAction = handler },
    // Reads `this`, exactly like the real RemoteElectronViewHost does.
    notifyUserActionError() {
      notifyCalls += 1
      void this.ready()
    },
    destroyView() {},
    showView() {},
    groupView() {},
  }
}

test('a failed toolbar action is reported without detaching the host method', async () => {
  const host = makeHost()
  const provider = new ElectronBrowserProvider(host)
  const handler = host.handlers.userAction
  assert.equal(typeof handler, 'function', 'the provider registered a user-action handler')

  // No session exists for this window key, so handleUserAction goes straight to
  // the error-reporting path — the one that used to crash the host.
  await handler({ type: 'navigate', windowId: 'window-without-session', url: 'http://127.0.0.1:4173/' })

  assert.equal(host.notifyCalls, 1, 'the host was told, on its own receiver')
})

test('a host whose notification throws cannot make reporting fatal', async () => {
  const host = makeHost()
  // The hostile variant: the host's own notify throws regardless of binding.
  host.notifyUserActionError = function notifyThatThrows() { throw new Error('host is gone') }
  const provider = new ElectronBrowserProvider(host)
  const handler = host.handlers.userAction

  // Reporting a failure must not become one: this must resolve, not reject.
  await handler({ type: 'navigate', windowId: 'window-without-session', url: 'http://127.0.0.1:4173/' })
})

test('fire-and-forget host methods never throw synchronously after dispose', () => {
  // Issue #16's second path: `void this.ready()` used to throw synchronously on a
  // disposed host, escaping every `.catch` the callers attach.
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  host.dispose()

  assert.doesNotThrow(() => host.notifyUserActionError('w1', 'boom'), 'notifyUserActionError')
  assert.doesNotThrow(() => host.destroyView({ id: 'v1' }), 'destroyView')
  assert.doesNotThrow(() => host.groupView({ id: 'v1' }, 'w1'), 'groupView')
  assert.doesNotThrow(() => host.showView({ id: 'v1' }), 'showView')
})

test('a disposed host rejects asynchronously instead of throwing', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  host.dispose()
  const view = host.createView()
  // Still fails — but as a rejection the caller can see, not a synchronous throw.
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }), /disposed/)
})
