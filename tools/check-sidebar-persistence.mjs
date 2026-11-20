import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
if (!root || !process.env.PERSISTENCE_EVIDENCE) throw new Error('Set DSH_SOURCE_ROOT and PERSISTENCE_EVIDENCE')
const evidence = resolve(process.env.PERSISTENCE_EVIDENCE)
await mkdir(evidence, { recursive: true })
const data = await mkdtemp(resolve(evidence, 'profile-'))
const server = createServer((_request, response) => { response.end('<!doctype html><title>Sidebar persistent session</title>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const fixture = fileURLToPath(new URL('./fixtures/sidebar-persistence.cjs', import.meta.url))
try {
  for (const [home, mode] of [['home-one', 'write'], ['home-one', 'read'], ['home-two', 'empty'], ['home-one', 'read']]) {
    await new Promise((resolve, reject) => {
      const child = spawn('dbus-run-session', ['--', 'xvfb-run', '-a',
        `${root}/apps/desktop/node_modules/electron/dist/electron`, '--no-sandbox', fixture], {
        stdio: 'inherit', env: { ...process.env, DSH_HOME: `${data}/${home}`, PERSISTENCE_USER_DATA: data,
          PERSISTENCE_URL: url, PERSISTENCE_MODE: mode },
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Electron persistence ${home}/${mode} exit ${code}`)))
    })
  }
  console.log('Sidebar restart persistence, cross-workspace sharing, and DSH_HOME isolation: PASS')
} finally { await new Promise(resolve => server.close(resolve)) }
