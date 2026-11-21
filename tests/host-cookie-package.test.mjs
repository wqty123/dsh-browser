import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

test('packed host and cookie jar load after extraction without plugin node_modules or runtime PSL dependencies', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-host-package-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const staging = join(directory, 'staging'), extracted = join(directory, 'extracted')
  mkdirSync(staging); mkdirSync(extracted)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies.tldts, undefined)
  assert.equal(manifest.dependencies['tldts-core'], undefined)
  assert.equal(manifest.devDependencies.esbuild, undefined)
  cpSync(new URL('../lib/', import.meta.url), join(staging, 'lib'), { recursive: true })
  for (const name of ['native-host', 'browser-extension']) cpSync(new URL(`../${name}/`, import.meta.url), join(staging, name), { recursive: true })
  writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest))
  const run = (command, args, cwd = directory) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, shell: process.platform === 'win32' && command === 'npm.cmd' })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  const blocker = `export function resolve(specifier, context, next) {
    if (specifier === 'esbuild' || /[/\\\\]esbuild[/\\\\]/u.test(specifier)) {
      throw Object.assign(new Error('esbuild is unavailable for this regression'), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    return next(specifier, context)
  }`
  const blockEsbuild = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(blocker))});`
  const modules = JSON.parse(run(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(blockEsbuild)}`, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    await assert.rejects(import('esbuild'), { code: 'ERR_MODULE_NOT_FOUND' });
    const { bundleHostCookies } = await import(${JSON.stringify(new URL('../scripts/bundle-host.mjs', import.meta.url).href)});
    console.log(JSON.stringify(await bundleHostCookies(new URL(${JSON.stringify(pathToFileURL(join(staging, 'lib/browser-electron/guest-cookie-jar.js')).href)}))));
  `]))
  for (const dependency of ['tldts', 'tldts-core']) {
    assert.ok(modules.some(path => path.replaceAll('\\', '/').includes(`/node_modules/${dependency}/`)
      || path.replaceAll('\\', '/').startsWith(`node_modules/${dependency}/`)), `${dependency} must be bundled without esbuild`)
  }
  const packed = JSON.parse(run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], staging))
  run('tar', ['-xzf', packed[0].filename, '-C', 'extracted'])
  const pkg = join(extracted, 'package')
  assert.equal(existsSync(join(pkg, 'node_modules')), false)
  const license = readFileSync(join(pkg, 'lib/browser-electron/guest-cookie-jar.LICENSE.txt'), 'utf8')
  assert.match(license, /tldts-core/); assert.match(license, /Permission is hereby granted, free of charge/)
  const jarUrl = pathToFileURL(join(pkg, 'lib/browser-electron/guest-cookie-jar.js')).href
  writeFileSync(join(pkg, 'unbundled.js'), "export { getDomain } from 'tldts'")
  run(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
    await assert.rejects(import('./unbundled.js'), error => error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('tldts'));
    const { GuestCookieJar } = await import(${JSON.stringify(jarUrl)});
    const jar = new GuestCookieJar(); jar.setCookies(new URL('https://passport.example.test/'), ['LOGIN=yes; Domain=example.test; Path=/', 'PSL=no; Domain=test']);
    assert.equal(jar.getDocumentCookie(new URL('https://www.example.test/')), 'LOGIN=yes');`], pkg)
  const loader = join(directory, 'host-peers.mjs')
  writeFileSync(loader, `let peers, parentURL;
    export function initialize(data) { ({ peers, parentURL } = data) }
    export function resolve(specifier, context, next) {
      return next(specifier, peers.includes(specifier) ? { ...context, parentURL } : context)
    }`)
  const register = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: ${JSON.stringify({ peers: Object.keys(manifest.peerDependencies), parentURL: new URL('../package.json', import.meta.url).href })} });`
  const imports = process.execArgv.flatMap((arg, index, args) => arg === '--import' ? [arg, args[index + 1]] : [])
  run(process.execPath, [...imports, '--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `import assert from 'node:assert/strict';
    for (const entry of ['lib/index.js', 'lib/browser-electron/entry.js']) {
      const plugin = await import(new URL(entry, ${JSON.stringify(pathToFileURL(pkg + '/').href)})); assert.equal(typeof plugin.apply, 'function');
    }
    console.log('extracted host entries and cookie jar loaded; no plugin node_modules');`], pkg)
})
