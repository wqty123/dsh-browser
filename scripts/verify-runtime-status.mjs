#!/usr/bin/env node
/**
 * Readiness-route probe: do the two endpoints the settings panel reads actually get registered,
 * and does the report they serve describe this machine?
 *
 * The unit tests cover the handlers and the report in isolation. What they cannot cover is the
 * WIRING between them — `ctx.inject(['webServer'])`, the two `webServer.register` calls, and the
 * deps that read the settings document and the install tree. That glue is exactly where this plugin
 * has lost a surface before (a route that was never registered because a dependency name was wrong
 * looks identical to a route that returned nothing), so it is checked here against the real host
 * packages, over real HTTP, with no browser and no DSH restart.
 *
 * Usage:
 *   node scripts/verify-runtime-status.mjs              # profile named by DSH_PROFILE, else the first
 *   DSH_PROFILE=desktop node scripts/verify-runtime-status.mjs
 *
 * It writes into a throwaway DSH_HOME, never the real one, and pins
 * ELECTRON_SKIP_BINARY_DOWNLOAD so a probe can never start a 100 MB download.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = new URL('..', import.meta.url)
const failures = []
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
  if (!condition) failures.push(label)
}

/** The profile whose node_modules resolve the host packages. */
function findProfileRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return undefined
  const named = process.env.DSH_PROFILE
  const candidates = named !== undefined && named !== ''
    ? [named]
    : readdirSync(profiles).filter(entry => existsSync(join(profiles, entry, 'package.json')))
  for (const candidate of candidates) {
    const manifest = join(profiles, candidate, 'package.json')
    if (existsSync(manifest)) return { name: candidate, manifest }
  }
  return undefined
}

const profile = findProfileRoot()
if (profile === undefined) {
  console.log('No DSH profile found under $DSH_HOME/profiles; nothing to verify.')
  process.exit(0)
}

// A settings document of our own, so the probe can name a channel without touching the user's file.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-runtime-probe-'))
process.env.DSH_HOME = sandboxHome
// The whole point is that a probe never downloads: this reports `skipped`, which is also a state the
// panel has to render.
process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1'

const require = createRequire(profile.manifest)
const load = async spec => import(pathToFileURL(require.resolve(spec)).href)
const cordis = await load('@deepseek-ai/cordis')

console.log(`Host: profile "${profile.name}" · sandbox DSH_HOME ${sandboxHome}`)
console.log('')

/** The host's web-server shape: exact paths, a handler, and an unsubscribe. */
class StubWebServer extends cordis.Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = new Map()
  }
  register(spec, label) {
    this.routes.set(spec.path, { handler: spec.handler, label })
    return () => this.routes.delete(spec.path)
  }
}

const root = new cordis.Context()
new StubWebServer(root)

const seam = await import(new URL('lib/browser/runtime.js', REPO).href)
new seam.default(root)
const entry = await import(new URL('lib/browser-electron/entry.js', REPO).href)
entry.apply(root, {})

const server = root.get('webServer')
// `ctx.inject([...], cb)` defers the callback until the dependency is available, which is a later
// turn of the loop — so the first read can legitimately see an empty route table. Poll briefly
// instead of asserting on a race; this is the difference between "not wired" and "not yet".
for (let waited = 0; waited < 2_000 && server.routes.size === 0; waited += 50) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
ok('the readiness routes are registered', server.routes.has('/dsh-builtin-browser/runtime-status')
  && server.routes.has('/dsh-builtin-browser/runtime-provision'),
  [...server.routes.keys()].join(', '))

// Serve exactly the handlers the plugin registered — no re-implementation in the probe.
const listener = createServer((req, res) => {
  const route = server.routes.get(new URL(req.url, 'http://localhost').pathname)
  if (route === undefined) { res.writeHead(404); res.end(); return }
  void route.handler(req, res)
})
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${listener.address().port}`

/** Headers a browser sends and a plain script does not — the admission rule keys off exactly these. */
const panelHeaders = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'zh-CN' }

try {
  const read = await fetch(`${base}/dsh-builtin-browser/runtime-status`, { headers: panelHeaders })
  const body = await read.json()
  ok('GET answers 200', read.status === 200, String(read.status))
  ok('the report names the channel the settings document holds', body.runtime?.channel === 'bundled', String(body.runtime?.channel))
  ok('the report resolves it to a carrier', body.runtime?.carrier === 'bundled', String(body.runtime?.carrier))
  ok('the runtime state is a state the panel can localize',
    ['idle', 'preparing', 'present', 'ready', 'skipped', 'failed'].includes(body.runtime?.electron?.state),
    String(body.runtime?.electron?.state))
  ok('the download opt-out is honoured, or a runtime is already there',
    body.runtime?.electron?.state !== 'preparing' && (body.runtime?.electron?.detail ?? '') !== '',
    `${String(body.runtime?.electron?.state)}: ${body.runtime?.electron?.detail ?? ''}`)
  ok('the bridge reading is one of the four states the panel knows',
    ['installed', 'missing', 'stale', 'absent'].includes(body.runtime?.bridge?.state),
    String(body.runtime?.bridge?.state))
  ok('installed and running are reported separately',
    typeof body.runtime?.bridge?.running === 'boolean' && typeof body.runtime?.bridge?.runningDetail === 'string',
    `running=${String(body.runtime?.bridge?.running)} — ${body.runtime?.bridge?.runningDetail ?? ''}`)
  ok('a runtime on disk is not described as "not asked for yet"',
    body.runtime?.electron?.state !== 'present' || !/not been asked/.test(body.runtime?.electron?.detail ?? ''),
    String(body.runtime?.electron?.detail ?? ''))
  ok('readiness is one of ready/blocked/unknown',
    ['ready', 'blocked', 'unknown'].includes(body.runtime?.readiness), String(body.runtime?.readiness))
  ok('readiness agrees with the two readings it is derived from',
    body.runtime?.readiness !== 'ready'
      || (body.runtime?.carrier === 'sidebar'
        ? body.runtime?.bridge?.state === 'installed' && body.runtime?.bridge?.running === true
        : body.runtime?.electron?.state === 'present' || body.runtime?.electron?.state === 'ready'),
    `carrier=${String(body.runtime?.carrier)} readiness=${String(body.runtime?.readiness)}`)

  const scripted = await fetch(`${base}/dsh-builtin-browser/runtime-provision`, { method: 'POST' })
  ok('a POST without browser headers is refused', scripted.status === 403, String(scripted.status))

  const started = await fetch(`${base}/dsh-builtin-browser/runtime-provision`, { method: 'POST', headers: panelHeaders })
  const startedBody = await started.json()
  ok('the panel may start it and gets a state back', started.status === 200 && startedBody.provision !== undefined,
    JSON.stringify(startedBody.provision ?? startedBody).slice(0, 120))
} catch (error) {
  ok('the routes answer over HTTP', false, String(error && error.message))
} finally {
  await new Promise(resolve => listener.close(resolve))
  await root.stop?.()
}

console.log('')
if (failures.length === 0) {
  console.log('VERDICT: the readiness routes are wired and answer on this host.')
} else {
  console.log(`VERDICT: ${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
