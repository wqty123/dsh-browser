// Consumer-layout install check for the packaged artifact.
//
// The promise this version is about ("it works once you install it") starts at INSTALL time: the
// tarball must install cleanly on a default pnpm profile, with no build-script approval and no
// network, and it must carry the files the readiness endpoints live in.
//
// Run: node scripts/consumer-install-check.mjs <tarball> <workdir>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [tarball, workdir] = process.argv.slice(2)
if (!tarball || !workdir) {
  console.error('usage: consumer-install-check.mjs <tarball> <workdir>')
  process.exit(2)
}

const pnpm = process.env.DSH_PNPM ?? 'pnpm'
const node = process.execPath

rmSync(workdir, { recursive: true, force: true })
mkdirSync(workdir, { recursive: true })
writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '1.0.0' }, null, 2))

const problems = []
let installOutput = ''
try {
  installOutput = execFileSync(node, [pnpm, 'add', tarball], {
    cwd: workdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_loglevel: 'info' },
  })
} catch (error) {
  installOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  problems.push(`install failed: ${String(error.message).split('\n')[0]}`)
}

// pnpm blocks dependency build scripts by default, and the whole point of moving the Electron
// download out of `postinstall` (issue #41) is that this never comes up again.
if (/Ignored build scripts/i.test(installOutput) || /ERR_PNPM_IGNORED_BUILDS/.test(installOutput)) {
  problems.push('install reported ignored build scripts, which is issue #41 again')
}

const installed = join(workdir, 'node_modules', 'dsh-builtin-browser')
const manifestPath = join(installed, 'package.json')
if (!existsSync(manifestPath)) {
  problems.push('the package was not installed')
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const scripts = Object.keys(manifest.scripts ?? {}).sort().join(',')
  if (scripts !== 'build,prepack,test') problems.push(`unexpected scripts: ${scripts}`)
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[lifecycle] !== undefined) problems.push(`install-time hook "${lifecycle}" is back`)
  }
  if (manifest.bin?.['dsh-browser-install-electron'] !== 'scripts/install-electron.mjs') {
    problems.push('the explicit provisioning command is missing from bin')
  }
  // The files the readiness endpoints are served from. A tarball that shipped an entry without them
  // would fail at request time with a module-resolution error instead of a panel.
  for (const file of [
    'lib/browser-electron/runtime-status.js',
    'lib/browser-electron/runtime-route.js',
    'desktop-bridge/install.mjs',
    'client.js',
  ]) {
    if (!existsSync(join(installed, file))) problems.push(`missing from the installed tree: ${file}`)
  }
}

console.log(JSON.stringify({ tarball, workdir, problems }, null, 2))
process.exit(problems.length === 0 ? 0 : 1)
