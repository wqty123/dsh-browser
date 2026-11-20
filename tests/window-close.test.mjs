// Closing the interface ends the session it showed — while browsing history and
// login state survive, so the next call opens a clean session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** Host stub that lets the test play the human closing a window. */
function makeHost() {
  let closed
  let views = 0
  let loads = 0
  let current = 'about:blank'
  return {
    /** Simulate the child reporting a window the human closed. */
    closeWindow(windowId) { closed?.(windowId) },
    get registered() { return closed !== undefined },
    createView() {
      return {
        id: `view${++views}`,
        async sendCommand(method, params) {
          if (method === 'Page.navigate') { loads += 1; current = params.url; return {} }
          if (method === 'Runtime.evaluate') {
            const expression = params.expression ?? ''
            if (expression.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
            if (expression.includes('document.title')) return { result: { value: `${current}\u0000Example` } }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    onUserAction() {},
    onViewClosed(handler) { closed = handler },
    destroyView() {}, showView() {}, groupView() {},
  }
}

test('the provider registers for window-close notices', () => {
  const host = makeHost()
  new ElectronBrowserProvider(host)
  assert.ok(host.registered, 'the host can report a closed window')
})

test('closing the window ends its session, and the next call starts fresh', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const first = await p.open('task-1')
  assert.ok(p.exists(first), 'session is live while its window is')

  host.closeWindow(first)
  // The handler is async; the session must be gone once it settles.
  for (let i = 0; i < 50 && p.exists(first); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(p.exists(first), false, 'closing the window ended the session')

  const second = await p.open('task-1')
  assert.notEqual(second, first, 'a later call opens a new session, not the dead one')
  assert.ok(p.exists(second))
  await p.close(second)
})

test('the browsing history of a closed window survives', async () => {
  const host = makeHost()
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-close-')), 'history.jsonl')
  // Recording is asynchronous, and the file does not exist until the first write.
  const read = () => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const p = new ElectronBrowserProvider(host, { history: { file } })
  const sid = await p.open('task-1')
  await p.navigate(sid, { url: 'https://example.com/kept' })

  for (let i = 0; i < 50 && !read().includes('/kept'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(read().includes('/kept'), 'visit recorded')

  host.closeWindow(sid)
  for (let i = 0; i < 50 && p.exists(sid); i++) await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(p.exists(sid), false, 'session ended')
  assert.ok(read().includes('/kept'), 'history is not part of the session')
  assert.equal(p.visited()[0].url, 'https://example.com/kept', 'still listable afterwards')
})

test('a notice for an unknown window is ignored, never thrown', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open('task-1')
  host.closeWindow('window-that-never-existed')
  host.closeWindow('')
  assert.ok(p.exists(sid), 'an unrelated notice leaves live sessions alone')
  await p.close(sid)
})
