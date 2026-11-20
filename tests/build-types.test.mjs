import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

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

test('SDK declarations isolate upstream implementations without suppressing plugin type errors', () => {
  const file = fileURLToPath(new URL('../src/__sdk_typecheck_fixture__.ts', import.meta.url))
  const source = "import type { Context } from '@deepseek-ai/cordis'; export const broken: number = 'wrong'; export type Host = Context"
  const host = ts.createCompilerHost(parsed.options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (path, ...args) => path === file ? ts.createSourceFile(file, source, ts.ScriptTarget.ES2022) : getSourceFile(path, ...args)
  const program = ts.createProgram([file], { ...parsed.options, noEmit: true }, host)
  const implementations = program.getSourceFiles().filter(source => !source.isDeclarationFile)
  assert.deepEqual(implementations.map(source => source.fileName), [file], 'no upstream implementation may enter the program')
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 1, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: path => path, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
  }))
  assert.equal(errors[0].code, 2322)
  assert.equal(errors[0].file.fileName, file)
})
