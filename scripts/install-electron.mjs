#!/usr/bin/env node
/** Provision an operator-owned or plugin-managed Electron runtime on demand. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const label = '[dsh-builtin-browser]'
const DEFAULT_ELECTRON_VERSION = '44.0.0'

function managedRuntimeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-host', 'electron-runtime')
}

function retryInstructions() {
  console.error(`${label} Set DSH_BROWSER_ELECTRON_PACKAGE to an absolute external electron package directory, or run npx --no dsh-browser-install-electron to install into ${managedRuntimeDir()}. The sidebar needs no standalone runtime.`)
}

function runCommand(command, args, stdio = ['ignore', 'inherit', 'inherit']) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio,
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function resolvePackageDir() {
  const explicit = process.env.DSH_BROWSER_ELECTRON_PACKAGE
  if (explicit !== undefined) {
    if (!explicit || !isAbsolute(explicit)) {
      throw new Error('An absolute external electron package directory is required when DSH_BROWSER_ELECTRON_PACKAGE is set.')
    }
    return explicit
  }
  const targetRoot = managedRuntimeDir()
  const pkgDir = join(targetRoot, 'node_modules', 'electron')
  if (existsSync(join(pkgDir, 'install.js'))) return pkgDir
  const parentDir = join(targetRoot, '..')
  mkdirSync(parentDir, { recursive: true })
  const stageDir = mkdtempSync(join(parentDir, 'electron-runtime-stage-'))
  const version = process.env.DSH_BROWSER_ELECTRON_VERSION || DEFAULT_ELECTRON_VERSION
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    console.log(`${label} Staging electron@${version} metadata into ${targetRoot}...`)
    const staged = await runCommand(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', stageDir, `electron@${version}`])
    if (staged.code !== 0) throw new Error(`npm install electron@${version} exited ${String(staged.code)}`)
    rmSync(targetRoot, { recursive: true, force: true })
    renameSync(stageDir, targetRoot)
    return pkgDir
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }
}

async function install() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log(`${label} Electron download skipped: ELECTRON_SKIP_BINARY_DOWNLOAD is set.`)
    return 0
  }
  const directory = await resolvePackageDir()
  const manifest = join(directory, 'package.json')
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  if (metadata.name !== 'electron') throw new Error('The external package must be named electron.')
  const installer = join(directory, 'install.js')
  if (!existsSync(installer)) throw new Error(`The installed electron package is incomplete: missing ${installer}`)
  const { version } = metadata
  console.log(`${label} Preparing Electron ${String(version)}. A missing runtime needs a network download; an existing runtime is reused.`)
  const result = await runCommand(process.execPath, [installer])
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
