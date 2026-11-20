import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export async function bundleHostCookies(destination = new URL('../lib/browser-electron/guest-cookie-jar.js', import.meta.url)) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/browser-electron/guest-cookie-jar.ts', import.meta.url))],
    outfile: fileURLToPath(destination),
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    target: 'es2022',
    metafile: true,
    banner: { js: '/*! Includes tldts and tldts-core (MIT); see guest-cookie-jar.LICENSE.txt. */' },
  })
  const tldts = require.resolve('tldts/package.json')
  const core = createRequire(tldts).resolve('tldts-core/package.json')
  const licenses = await Promise.all([tldts, core].map(async manifest =>
    JSON.parse(await readFile(manifest, 'utf8')).name + '\n\n' + await readFile(join(dirname(manifest), 'LICENSE'), 'utf8')))
  await writeFile(new URL('guest-cookie-jar.LICENSE.txt', destination), licenses.join('\n\n'))
  return result.metafile
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await bundleHostCookies()
