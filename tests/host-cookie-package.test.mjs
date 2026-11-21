import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packedPackage } from './fixtures/packed-package.mjs'

test('packed host and cookie jar load after extraction without plugin node_modules or runtime PSL dependencies', async t => {
  const { root: directory, pkg, manifest, run } = packedPackage(t)
  const staging = join(directory, 'no-esbuild')
  mkdirSync(join(staging, 'lib/browser-electron'), { recursive: true })
  assert.equal(manifest.dependencies.tldts, undefined)
  assert.equal(manifest.dependencies['tldts-core'], undefined)
  assert.equal(manifest.devDependencies.esbuild, undefined)
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
  for (const missing of ['native-host', 'browser-extension']) {
    const saved = join(directory, missing)
    renameSync(join(pkg, missing), saved)
    run(process.execPath, [...imports, '--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `import assert from 'node:assert/strict';
      const plugin = await import('./lib/browser-electron/entry.js'); assert.equal(typeof plugin.apply, 'function');
      const { ExtensionBrowserViewHost } = await import('./lib/browser-electron/extension-browser.js');
      const host = new ExtensionBrowserViewHost('edge');
      await assert.rejects(host.prepare(), /Extension carrier unavailable/);
      assert.equal(host.connectionStatus().connected, false);
      assert.match(host.connectionStatus().detail, /unavailable/);
      host.dispose();`], pkg)
    renameSync(saved, join(pkg, missing))
  }
})
