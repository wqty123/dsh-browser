import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInstallerSandbox, INSTALLER_TEST_MARKER } from './helpers/installer-sandbox.mjs'

const query = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + 'Get-CimInstance Win32_Process -ErrorAction Stop | '
  + 'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
const args = ['-NoProfile', '-NonInteractive', '-Command', query]
function run(env, source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
}
function value(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('the closed-Desktop preload supplies only its own complete process record', () => {
  const sandbox = createInstallerSandbox()
  try {
    const result = value(run(sandbox.env(), `import {execFileSync} from 'node:child_process';
      const args=${JSON.stringify(args)};
      const record=JSON.parse(execFileSync('powershell.exe',args,{encoding:'utf8'}));
      console.log(JSON.stringify({record,pid:process.pid,exe:process.execPath,buffer:Buffer.isBuffer(execFileSync('powershell.exe',args))}));`))
    assert.equal(result.record.length, 1)
    assert.equal(result.record[0].ProcessId, result.pid)
    assert.equal(result.record[0].ExecutablePath, result.exe)
    assert.equal(result.record[0].ParentProcessId, 1)
    assert.equal(typeof result.record[0].Name, 'string')
    assert.equal(typeof result.record[0].CommandLine, 'string')
    assert.equal(result.buffer, true, 'the interception retains execFileSync buffer semantics')
  } finally { sandbox.close() }
})

test('the closed-Desktop preload refuses a missing or invalid private marker before any query', () => {
  const sandbox = createInstallerSandbox()
  const marker = join(sandbox.root, INSTALLER_TEST_MARKER), valid = readFileSync(marker)
  try {
    const missingRoot = sandbox.env(); delete missingRoot.DSH_BRIDGE_TEST_ROOT
    const missing = run(missingRoot, 'throw Error("main body must not execute")')
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /test isolation refused/)
    writeFileSync(marker, 'invalid-marker')
    const invalid = run(sandbox.env(), 'throw Error("main body must not execute")')
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /test isolation refused/)
    assert.doesNotMatch(invalid.stderr, /Error: main body must not execute/)
  } finally { writeFileSync(marker, valid); sandbox.close() }
})

test('other commands and near-matching PowerShell queries reach the original function unchanged', () => {
  const sandbox = createInstallerSandbox()
  try {
    const sentinel = join(sandbox.root, 'original-child-process.cjs')
    writeFileSync(sentinel, `require('node:child_process').execFileSync=(command,args)=>JSON.stringify({forwarded:true,command,args});require('node:module').syncBuiltinESMExports();`)
    const environment = sandbox.env({ NODE_OPTIONS: `--require "${sentinel.replaceAll('\\', '/')}"` })
    const forwarded = value(run(environment, `import {execFileSync} from 'node:child_process';
      const calls=[['powershell.exe',['-NoProfile','-Command','Write-Output safe']],['powershell.exe',${JSON.stringify([...args.slice(0, 3), query.replace('Name,ExecutablePath', 'Name,SessionId,ExecutablePath')])}],['different.exe',${JSON.stringify(args)}]];
      console.log(JSON.stringify(calls.map(([command,args])=>JSON.parse(execFileSync(command,args,{encoding:'utf8'})))));`))
    assert.equal(forwarded.length, 3)
    assert.ok(forwarded.every(result => result.forwarded === true))
    assert.equal(forwarded[0].args[2], 'Write-Output safe')
    assert.match(forwarded[1].args[3], /SessionId/)
    assert.equal(forwarded[2].command, 'different.exe')
    const notTesting = value(run({ ...environment, DSH_BROWSER_TEST: '0' }, `import {execFileSync} from 'node:child_process';console.log(execFileSync('powershell.exe',${JSON.stringify(args)},{encoding:'utf8'}));`))
    assert.equal(notTesting.forwarded, true, 'the preload has no interception outside explicit test mode')
  } finally { sandbox.close() }
})

test('sandbox preload paths with spaces preserve an existing Node import option', async () => {
  const sandbox = createInstallerSandbox()
  let copiedSandbox
  try {
    const directory = sandbox.temp('helper with spaces-')
    for (const name of ['installer-sandbox.mjs', 'closed-desktop-preload.cjs']) copyFileSync(fileURLToPath(new URL('./helpers/' + name, import.meta.url)), join(directory, name))
    const existingImport = join(directory, 'existing import.mjs')
    writeFileSync(existingImport, 'globalThis.existingNodeImport="preserved";')
    const helper = await import(pathToFileURL(join(directory, 'installer-sandbox.mjs')).href)
    copiedSandbox = helper.createInstallerSandbox()
    const prefix = `--import "${pathToFileURL(existingImport).href}" --no-warnings`
    const environment = copiedSandbox.env({ NODE_OPTIONS: prefix })
    assert.ok(environment.NODE_OPTIONS.startsWith(prefix + ' '), 'existing NODE_OPTIONS is preserved verbatim')
    assert.ok(environment.NODE_OPTIONS.includes(`--require "${join(directory, 'closed-desktop-preload.cjs').replaceAll('\\', '/')}"`))
    const result = value(run(environment, `import {execFileSync} from 'node:child_process';console.log(JSON.stringify({imported:globalThis.existingNodeImport,rows:JSON.parse(execFileSync('powershell.exe',${JSON.stringify(args)},{encoding:'utf8'})).length}));`))
    assert.deepEqual(result, { imported: 'preserved', rows: 1 })
  } finally { copiedSandbox?.close(); sandbox.close() }
})
