#!/usr/bin/env node
/**
 * Provision the plugin's installed Electron dependency during postinstall or an
 * explicit retry. Electron 44 no longer downloads its binary on package install,
 * and browser discovery deliberately remains a pure filesystem probe.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const label = '[dsh-builtin-browser]'

function retryInstructions() {
  console.error(`${label} Retry from the profile that installed this plugin: npx --no dsh-browser-install-electron`)
}

async function install() {
  // Respect operators who provision their runtime separately, including CI.
  // --ignore-scripts is enforced by the package manager; the explicit bin remains
  // usable afterwards without changing the profile's lifecycle-script policy.
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

  // Run the actual dependency's installer, never require('electron'): in an
  // Electron host that module name is the built-in API. Upstream validates its
  // dist/version, path.txt and executable before deciding whether to download.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
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
