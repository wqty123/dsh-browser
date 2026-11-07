#!/usr/bin/env node
/** Build and run tests inside an explicit, marked bridge-installer boundary. */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstallerSandbox } from '../tests/helpers/installer-sandbox.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const sandbox = createInstallerSandbox()
const environment = sandbox.env()
function run(argv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, argv, { cwd: repo, env: environment, stdio: 'inherit', windowsHide: true })
    child.once('error', error => { console.error(error); resolve(1) })
    child.once('close', code => resolve(code ?? 1))
  })
}

let code = await run([require.resolve('typescript/bin/tsc'), '-p', join(repo, 'tsconfig.json')])
if (code === 0) {
  const requested = process.argv.slice(2)
  const files = requested.length === 0
    ? readdirSync(join(repo, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(repo, 'tests', name))
    : requested
  code = await run(['--test', ...files])
}
if (code === 0) sandbox.close()
else console.error(`Failed-test sandbox retained for diagnosis: ${sandbox.root}`)
process.exitCode = code
