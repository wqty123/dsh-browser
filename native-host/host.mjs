import { createServer } from 'node:net'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decoder, send, chunkMessage, Reassembler } from './protocol.mjs'
import { proof } from './client.mjs'

export function saveConfiguration(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { try { unlinkSync(temporary) } catch {} }
}

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function pair(path, token, installId) {
  if (typeof token !== 'string' || token.length > 128 || !/^[a-f0-9-]{36}$/.test(installId ?? '')) throw Error('invalid pairing request')
  const lock = join(dirname(path), 'pair.lock')
  const fd = openSync(lock, 'wx', 0o600)
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const digest = createHash('sha256').update(token).digest('hex')
    if (!config.pairExpires || Date.now() > config.pairExpires || !equal(digest, config.pairDigest)) throw Error('pair token is invalid, expired or already used')
    delete config.pairDigest; delete config.pairExpires
    config.installId = installId
    saveConfiguration(path, config)
    return config
  } finally { closeSync(fd); unlinkSync(lock) }
}

export async function serve({ input, output, configPath, origin }) {
  let config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin ?? '') || origin !== `chrome-extension://${config.extensionId}/`
    || !/^[a-f0-9]{64}$/.test(config.secret ?? '') || !['edge', 'chrome'].includes(config.browser)) throw Error('native origin is not allowed')
  let installId, server, controller, endpoint, watcher, stopped = false
  const epoch = randomUUID(), pending = new Map(), peers = new Set(), chunks = new Reassembler()
  const post = value => send(output, value)
  const forward = value => { if (controller) for (const part of chunkMessage(value)) send(controller, part) }
  const status = (state, detail) => post({ type: 'status', state, detail })
  const release = () => {
    for (const id of pending.keys()) chunks.forget(id)
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    try { post({ type: 'release' }) } catch {}
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    watcher?.close()
    release()
    for (const socket of peers) socket.destroy()
    server?.close()
    try {
      const descriptor = JSON.parse(readFileSync(join(dirname(configPath), 'relay.json'), 'utf8'))
      if (descriptor.epoch === epoch) unlinkSync(join(dirname(configPath), 'relay.json'))
    } catch {}
    if (process.platform !== 'win32' && endpoint) { try { unlinkSync(endpoint) } catch {} }
    input.destroy(); output.end()
  }
  watcher = watch(dirname(configPath), { persistent: false }, (_event, file) => {
    if (String(file) !== 'config.json') return
    try {
      const current = JSON.parse(readFileSync(configPath, 'utf8'))
      if (current.secret !== config.secret || current.installId !== config.installId) stop()
    } catch { stop() }
  })
  async function listen() {
    if (server || stopped) return
    endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-browser-${epoch}` : join(dirname(configPath), `relay-${epoch.slice(0, 8)}.sock`)
    if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 100) throw Error('native-host directory is too long for a local socket')
    server = createServer(socket => {
      if (peers.size >= 8) { socket.destroy(); return }
      peers.add(socket)
      const nonce = randomBytes(32).toString('hex')
      let authenticated = false
      const timer = setTimeout(() => socket.destroy(), 5000)
      send(socket, { type: 'challenge', nonce, epoch, proof: proof(config.secret, nonce, epoch, `${config.installId}:server`) })
      const frames = decoder(message => {
        if (!authenticated) {
          if (message.type !== 'auth' || controller || !equal(message.proof, proof(config.secret, nonce, epoch, config.installId))) { socket.destroy(); return }
          authenticated = true; clearTimeout(timer); controller = socket
          send(socket, { type: 'ready', epoch, installId: config.installId, browser: config.browser })
          return
        }
        if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 128 || pending.has(message.id)
          || pending.size >= 32 || !message.operation || typeof message.operation !== 'object') { socket.destroy(); return }
        const timeout = setTimeout(() => {
          pending.delete(message.id); chunks.forget(message.id)
          try { forward({ type: 'result', id: message.id, error: 'extension operation timed out; not replayed' }) } catch { socket.destroy() }
        }, 15000)
        pending.set(message.id, timeout)
        post(message)
      }, () => socket.destroy())
      socket.on('data', value => frames.push(value))
      socket.on('error', () => socket.destroy())
      socket.on('close', () => {
        clearTimeout(timer); peers.delete(socket)
        if (controller === socket) { controller = undefined; release() }
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
    if (stopped) { stop(); return }
    saveConfiguration(join(dirname(configPath), 'relay.json'), { endpoint, epoch })
    status('connected', `Paired ${config.browser}: ${config.label}`)
  }
  const frames = decoder(part => {
    void (async () => {
      if (part.type === 'hello') {
        if (installId || part.browser !== config.browser || !/^[a-f0-9-]{36}$/.test(part.installId ?? '')) throw Error('invalid extension identity')
        installId = part.installId
        if (config.installId && config.installId !== installId) { status('not-paired', 'A different browser profile is paired. Re-pair explicitly to replace it.'); return }
        if (config.installId) await listen()
        else status('not-paired', 'Enter the one-time token in extension options.')
      } else if (part.type === 'pair') {
        try {
          if (!installId || server) throw Error('pairing is not available')
          config = pair(configPath, part.token, installId)
          await listen()
          post({ type: 'paired', id: part.id, ok: true })
        } catch { post({ type: 'paired', id: part.id, ok: false, error: 'Pairing refused: token expired/used, wrong profile, or host unavailable.' }) }
      } else if (part.type === 'event') {
        if (server && controller) send(controller, part)
      } else {
        if (!server || typeof part.id !== 'string' || !pending.has(part.id)) return
        const message = chunks.accept(part)
        if (!message) return
        if (message.type !== 'result') throw Error('invalid extension response')
        clearTimeout(pending.get(message.id)); pending.delete(message.id)
        forward(message)
      }
    })().catch(stop)
  }, stop)
  input.on('data', value => frames.push(value))
  input.on('end', () => { frames.end(); stop() })
  input.on('error', stop); output.on('error', stop)
  return { stop }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const at = process.argv.indexOf('--config')
  try {
    if (at < 0 || !process.argv[at + 1]) throw Error('missing native configuration')
    await serve({ input: process.stdin, output: process.stdout, configPath: process.argv[at + 1], origin: process.argv[at + 2] })
  } catch { process.exitCode = 1; process.stdin.destroy() }
}
