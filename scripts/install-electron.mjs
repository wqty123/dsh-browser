#!/usr/bin/env node
/** Explicitly provision the installed Electron dependency; never run during plugin installation. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const label = '[dsh-builtin-browser]'

function retryInstructions() {
  console.error(`${label} Retry from the profile that installed this plugin: npx --no dsh-browser-install-electron`)
}

async function install() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log(`${label} Electron download skipped: ELECTRON_SKIP_BINARY_DOWNLOAD is set.`)
    return 0
  }
  const require = createRequire(import.meta.url)
  let manifest
  try {
    manifest = require.resolve('electron/package.json')
  } catch (error) {
    throw new Error(`Cannot resolve the installed electron dependency. Reinstall this plugin in the same profile. ${error.message}`)
  }
  const installer = join(dirname(manifest), 'install.js')
  if (!existsSync(installer)) throw new Error(`The installed electron package is incomplete: missing ${installer}`)
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
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
