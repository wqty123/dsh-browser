// 出口收尾：写回两套出口（构建链会按打包产物覆盖 `exports`，所以每次构建后都要重写）。
//
//   `exports`               —— 工作区/dev：指向 **源码**。
//   `publishConfig.exports` —— 发布/安装：宿主侧 `lib/*.js`（tsc 编译、说明符已改写成 .js），
//                              客户端半 `lib/client.js`（DSH 0.2.3 `{ id, factory, meta }` 工厂）。
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(path, 'utf8'))

/** dev/工作区出口：源码。 */
const devExports = {
  '.': './src/index.ts',
  './browser': './src/browser/runtime.ts',
  './browser-electron': './src/browser-electron/entry.ts',
  './tool-browser': './src/tool-browser/index.ts',
  './startpage': './src/startpage.ts',
  './client': './src/client/index.ts',
  './cordis.patch.yml': './cordis.patch.yml',
  './package.json': './package.json',
}

/** 发布出口：lib（宿主）+ lib/client.js（DSH 0.2.3 客户端工厂）。 */
const publishExports = {
  '.': './lib/index.js',
  './browser': './lib/browser/runtime.js',
  './browser-electron': './lib/browser-electron/entry.js',
  './tool-browser': './lib/tool-browser/index.js',
  './startpage': './lib/startpage.js',
  './client': './lib/client.js',
  './cordis.patch.yml': './cordis.patch.yml',
  './package.json': './package.json',
}

manifest.exports = devExports
manifest.publishConfig = { exports: publishExports }
manifest.files = ['lib', 'src', 'scripts', 'tools/accept-desktop.mjs', 'desktop-bridge', 'dsh-host-patch', '!dsh-host-patch/sources', 'browser-extension', 'native-host', 'cordis.patch.yml', 'CHANGELOG.md', 'README.md', 'docs', 'skills', 'assets', '!src/**/__tests__']

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log('exports 已写回：dev→src（源码），publish→lib + lib/client.js')
