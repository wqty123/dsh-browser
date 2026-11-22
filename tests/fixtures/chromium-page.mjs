import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function chromiumPage(t) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-native-reveal-'))
  const chrome = spawn(process.env.DSH_TEST_CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = once(chrome, 'exit')
  let socket
  t.after(async () => {
    socket?.close(); chrome.kill(); await exited
    rmSync(profile, { recursive: true, force: true })
  })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium debugging endpoint unavailable')), 10000)
    chrome.once('error', error => { clearTimeout(timer); reject(error) })
    let output = ''
    chrome.stderr.on('data', chunk => {
      output += chunk
      const endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]
      if (endpoint) { clearTimeout(timer); resolve(endpoint) }
    })
  })
  socket = new WebSocket(endpoint)
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data), request = pending.get(data.id)
    if (request) {
      pending.delete(data.id); clearTimeout(request.timer)
      if (data.error) request.reject(new Error(JSON.stringify(data.error)))
      else request.resolve(data.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const command = (method, params, targetSessionId = sessionId) => send(method, params, targetSessionId)
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  return { command, evaluate, async navigate(url) {
    await command('Page.navigate', { url })
    await evaluate(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('document not ready')) }, 5000);
      const poll = setInterval(() => {
        if (location.href === ${JSON.stringify(url)} && document.readyState === 'complete') {
          clearInterval(poll); clearTimeout(timer); resolve(true);
        }
      }, 10);
    })`)
  } }
}
