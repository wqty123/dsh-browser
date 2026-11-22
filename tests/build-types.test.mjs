import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const config = fileURLToPath(new URL('./fixtures/sdk-types/tsconfig.json', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/sdk-types/plugin.ts', import.meta.url)).replaceAll('\\', '/')

function compile(...args) {
  const result = spawnSync(process.execPath, [tsc, '-p', config, '--noEmit', '--pretty', 'false', ...args], { encoding: 'utf8' })
  assert.equal(result.error, undefined, result.error?.message)
  return { status: result.status, output: result.stdout + result.stderr }
}

test('host typechecking resolves SDK declarations without upstream implementations', () => {
  const result = compile('--listFilesOnly')
  assert.equal(result.status, 0, result.output)
  const files = result.output.split(/\r?\n/).map(path => path.trim().replaceAll('\\', '/')).filter(path => /\.[cm]?tsx?$/i.test(path))
  assert.ok(files.includes(fixture), result.output)
  assert.ok(files.some(path => path.endsWith('/@deepseek-ai/cordis/lib/types/index.d.ts')), result.output)
  assert.deepEqual(files.filter(path => !/\.d\.[cm]?ts$/i.test(path)), [fixture], 'no upstream implementation may enter the program')
  const settings = JSON.parse(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8'))
  assert.equal(settings.compilerOptions.strict, true)
  assert.equal(settings.compilerOptions.skipLibCheck, true)
})

test('SDK isolation does not suppress type errors or strict checking in plugin files', () => {
  const result = compile()
  assert.notEqual(result.status, 0, 'invalid plugin source must fail typechecking')
  assert.match(result.output, /error TS2322:/)
  assert.match(result.output, /error TS7006:/)
  const errors = result.output.split(/\r?\n/).filter(line => /error TS\d+:/.test(line))
  assert.equal(errors.length, 2, result.output)
  assert.ok(errors.every(line => /plugin\.ts\(/.test(line)), result.output)
})
