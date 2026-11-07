import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'
import { writeAsar, MAIN_BODY, manifestFor } from './fake-asar.mjs'

const script = fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url))

test('installer discovery, reads and rename bypass an Electron-style filesystem that locks ASAR', () => {
  const sandbox = createInstallerSandbox()
  try {
    const root = sandbox.temp('desktop-'), modules = join(sandbox.root, 'modules')
    const archive = join(root, 'resources', 'app.asar')
    writeAsar(archive, { 'package.json': manifestFor('@deepseek-ai/dsh-desktop'), 'lib/main.js': MAIN_BODY })
    const before = readFileSync(archive)
    mkdirSync(join(modules, 'original-fs'), { recursive: true })
    writeFileSync(join(modules, 'original-fs', 'index.js'), 'module.exports=globalThis.__installerRawFs;')
    const counts = join(sandbox.root, 'counts.json'), preload = join(sandbox.root, 'electron-fs.mjs')
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const raw={...fs};const counts={patched:0,rawProbes:0,renamed:0};
for(const name of ['existsSync','statSync','readFileSync','openSync','renameSync']){
 const original=raw[name];raw[name]=(...args)=>{if(String(args[0]).endsWith('.asar')){counts.rawProbes++;if(name==='renameSync')counts.renamed++}return original(...args)};
 const patched=fs[name];fs[name]=(...args)=>{if(String(args[0]).endsWith('.asar')){counts.patched++;throw Error('Electron ASAR cache would retain a lock')}return patched(...args)};
}globalThis.__installerRawFs=raw;syncBuiltinESMExports();
process.on('exit',()=>raw.writeFileSync(${JSON.stringify(counts)},JSON.stringify(counts)));
`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, root], {
      env: sandbox.env({ NODE_PATH: modules }), encoding: 'utf8', windowsHide: true, timeout: 20_000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(existsSync(archive), false)
    assert.ok(readFileSync(archive + '.before-bridge').equals(before))
    const measured = JSON.parse(readFileSync(counts, 'utf8'))
    assert.equal(measured.patched, 0)
    assert.ok(measured.rawProbes > 0)
    assert.equal(measured.renamed, 1)
  } finally { sandbox.close() }
})

test('an executable name cannot authorize an archive whose manifest is missing', () => {
  const sandbox = createInstallerSandbox()
  try {
    const root = sandbox.temp('unidentified-')
    writeAsar(join(root, 'resources', 'app.asar'), { 'lib/main.js': MAIN_BODY, 'note.txt': '@deepseek-ai/dsh-desktop' })
    writeFileSync(join(root, 'DeepSeek Harness.exe'), 'not an identity')
    const result = spawnSync(process.execPath, [script, root, '--preflight'], { env: sandbox.env(), encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout.trim()).ok, false)
    assert.equal(existsSync(join(root, 'resources', 'app')), false)
  } finally { sandbox.close() }
})
