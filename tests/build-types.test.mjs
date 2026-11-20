import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const configPath = fileURLToPath(new URL('../tsconfig.build.json', import.meta.url))
const config = ts.readConfigFile(configPath, ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL('../', import.meta.url)))

test('host typechecking resolves the published SDK contract, not workspace source exports', () => {
  const host = {
    ...ts.sys,
    readFile(path) {
      const text = ts.sys.readFile(path)
      if (text && /@deepseek-ai[/\\]cordis[/\\]package\.json$/.test(path)) {
        return JSON.stringify({ ...JSON.parse(text), exports: { '.': './src/index.ts' } })
      }
      return text
    },
  }
  const module = ts.resolveModuleName('@deepseek-ai/cordis', fileURLToPath(new URL('../src/index.ts', import.meta.url)), parsed.options, host).resolvedModule
  assert.ok(module)
  assert.match(module.resolvedFileName.replaceAll('\\', '/'), /\/lib\/types\/index\.d\.ts$/)
  assert.equal(parsed.options.skipLibCheck, true)
  assert.equal(parsed.options.strict, true)
  assert.ok(parsed.fileNames.every(path => !path.replaceAll('\\', '/').includes('/__tests__/')))
})
