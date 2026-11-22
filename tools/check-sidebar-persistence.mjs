import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
if (!root || !process.env.PERSISTENCE_EVIDENCE) throw new Error('Set DSH_SOURCE_ROOT and PERSISTENCE_EVIDENCE')
const evidence = resolve(process.env.PERSISTENCE_EVIDENCE)
await mkdir(evidence, { recursive: true })
const data = await mkdtemp(resolve(evidence, 'profile-'))
const server = createServer((request, response) => {
  if (request.url === '/clear-site-data') response.setHeader('Clear-Site-Data', '"cookies", "storage"')
  response.end('<!doctype html><title>Sidebar persistent session</title><script>window.firstCookie='
    + JSON.stringify(request.headers.cookie ?? '').replaceAll('<', '\\u003c') + '</script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const fixture = fileURLToPath(new URL('./fixtures/sidebar-persistence.cjs', import.meta.url))
const sidecar = resolve(data, 'home-one/dsh-builtin-browser-host/desktop-session-cookies.json')
let stale
try {
  for (const [home, mode] of [
    ['home-one', 'write'], ['home-one', 'read'], ['home-two', 'empty'],
    ['home-one', 'replace'], ['home-one', 'read-replaced'], ['home-one', 'crash'], ['home-one', 'read-crash'],
    ['home-one', 'delete'], ['home-one', 'read-deleted'], ['home-one', 'clear'], ['home-one', 'empty'],
    ['home-three', 'write'], ['home-three', 'http-clear'], ['home-three', 'read-http-clear'],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn('dbus-run-session', ['--', 'xvfb-run', '-a',
        `${root}/apps/desktop/node_modules/electron/dist/electron`, '--no-sandbox', fixture], {
        stdio: 'inherit', env: { ...process.env, DSH_HOME: `${data}/${home}`, PERSISTENCE_USER_DATA: data,
          PERSISTENCE_URL: url, PERSISTENCE_MODE: mode },
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        const expected = mode === 'crash' ? code === 137 || signal === 'SIGKILL' : code === 0
        if (expected) resolve()
        else reject(new Error(`Electron persistence ${home}/${mode} exit ${code}/${signal}`))
      })
    })
    if (home === 'home-one' && mode === 'write') stale = await readFile(sidecar)
    if (mode === 'replace') await writeFile(sidecar, stale)
  }
  console.log('Sidebar restart, session scope, stale replacement, deletion, clear-site-data and crash recovery: PASS')
} finally { await new Promise(resolve => server.close(resolve)) }
