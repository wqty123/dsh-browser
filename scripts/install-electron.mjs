#!/usr/bin/env node
/** Provision an operator-owned runtime outside the plugin installation closure. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const label = '[dsh-builtin-browser]'

function retryInstructions() {
  console.error(`${label} Set DSH_BROWSER_ELECTRON_PACKAGE to an absolute external electron package directory, then run npx --no dsh-browser-install-electron. The sidebar needs no standalone runtime.`)
}

async function install() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log(`${label} Electron download skipped: ELECTRON_SKIP_BINARY_DOWNLOAD is set.`)
    return 0
  }
  const directory = process.env.DSH_BROWSER_ELECTRON_PACKAGE
  if (!directory || !isAbsolute(directory)) throw new Error('An absolute external electron package directory is required; this plugin does not depend on electron.')
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
