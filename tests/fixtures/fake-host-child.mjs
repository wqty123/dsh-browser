// Fake "browser host" child for the remote-host recovery tests. Speaks the
// same line-delimited JSON-RPC protocol as host-main.js (hello with the spawn
// token, then ping / createView / groupView / showView / destroyView /
// command), but it is plain Node — so the host lifecycle (spawn, crash,
// auto-restart) is testable without a real Electron binary or display.
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

const portArg = process.argv.indexOf('--rpc-port')
const port = Number(process.argv[portArg + 1])
const token = process.env.DSH_BROWSER_RPC_TOKEN ?? ''

const socket = createConnection({ host: '127.0.0.1', port })
socket.setEncoding('utf8')
// First message must prove knowledge of the spawn token, like host-main.js.
socket.write(JSON.stringify({ id: 0, op: 'hello', token }) + '\n')

function reply(id, payload) {
  socket.write(JSON.stringify({ id, ...payload }) + '\n')
}

const rl = createInterface({ input: socket })
rl.on('line', line => {
  const text = line.trim()
  if (text === '') return
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return
  if (msg.op === 'command') {
    // The test kills this child mid-command to simulate a crash. Deliberately
    // no reply: the pending RPC is rejected when the parent notices the exit.
    if (msg.method === '__die') process.exit(1)
    return reply(msg.id, { ok: true, result: { value: 'fake' } })
  }
  // ping / createView / groupView / showView / destroyView / userActionError
  reply(msg.id, { ok: true })
})

// Leave with the parent (dispose, or the parent's own death) so no zombie
// node process survives between or after tests.
socket.on('close', () => process.exit(0))
socket.on('error', () => {})
