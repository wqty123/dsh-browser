#!/usr/bin/env node
/** Provision the standalone Electron runtime into `$DSH_HOME/dsh-builtin-browser-host/electron-runtime` (or an explicitly selected external package). */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const label = '[dsh-builtin-browser]'
const MANAGED_ELECTRON_VERSION = '44.10.0'

function managedRuntimeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-host', 'electron-runtime')
}

function retryInstructions() {
  console.error(`${label} Run npx --no dsh-browser-install-electron (or set ELECTRON_MIRROR / DSH_BROWSER_ELECTRON_PACKAGE) to retry. The sidebar needs no standalone runtime.`)
}

async function ensurePackage(override) {
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) {
      throw new Error('An absolute external electron package directory is required when DSH_BROWSER_ELECTRON_PACKAGE is set.')
    }
    return override
  }
  const runtimeDir = managedRuntimeDir()
  const targetPkg = join(runtimeDir, 'node_modules', 'electron')
  if (existsSync(join(targetPkg, 'install.js'))) return targetPkg
  mkdirSync(runtimeDir, { recursive: true })
  const stagingDir = join(runtimeDir, `.staging-${process.pid}-${randomUUID()}`)
  mkdirSync(stagingDir, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const spec = `electron@${process.env.DSH_BROWSER_ELECTRON_VERSION || MANAGED_ELECTRON_VERSION}`
  console.log(`${label} Fetching ${spec} installer metadata into ${runtimeDir}...`)
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(npm, ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--prefix', stagingDir, spec], {
        env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (result.code !== 0) {
      throw new Error(`npm install ${spec} failed (${result.signal ? `signal ${result.signal}` : `exit ${String(result.code)}`})`)
    }
    const stagedPkg = join(stagingDir, 'node_modules', 'electron')
    if (!existsSync(join(stagedPkg, 'install.js'))) {
      throw new Error(`Downloaded ${spec} package is incomplete: missing install.js`)
    }
    mkdirSync(join(runtimeDir, 'node_modules'), { recursive: true })
    rmSync(targetPkg, { recursive: true, force: true })
    renameSync(stagedPkg, targetPkg)
    return targetPkg
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

async function install() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log(`${label} Electron download skipped: ELECTRON_SKIP_BINARY_DOWNLOAD is set.`)
    return 0
  }
  const directory = await ensurePackage(process.env.DSH_BROWSER_ELECTRON_PACKAGE)
  const manifest = join(directory, 'package.json')
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  if (metadata.name !== 'electron') throw new Error('The external package must be named electron.')
  const installer = join(directory, 'install.js')
  if (!existsSync(installer)) throw new Error(`The installed electron package is incomplete: missing ${installer}`)
  const { version } = metadata
  console.log(`${label} Preparing Electron ${String(version)}. A missing runtime needs a network download; an existing runtime is reused.`)
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0) {
    console.error(`${label} Electron installation failed (${result.signal ? `signal ${result.signal}` : `exit ${String(result.code)}`}). Fix the reported network, checksum or permission error before retrying.`)
    retryInstructions()
    return result.code ?? 1
  }
  console.log(`${label} Electron runtime is ready.`)
  return 0
}

try {
  process.exitCode = await install()
} catch (error) {
  console.error(`${label} ${error instanceof Error ? error.message : String(error)}`)
  retryInstructions()
  process.exitCode = 1
}
