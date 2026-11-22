// 出口收尾：写回两套出口（构建链会按打包产物覆盖 `exports`，所以每次构建后都要重写）。
//
//   `exports`            —— 工作区/dev：指向 **源码**。与仓库其它包一致；dev 宿主的客户端半按源码
//                           加载，如果指向打包产物，产物顶部那句 `window.__ModuleLoader__.load(…)`
//                           在 dev 的首屏引导阶段还没有全局可用，整页会白屏（实测）。
//   `publishConfig.exports` —— 发布/安装：宿主侧 `lib/*.js`（tsc 编译、说明符已改写成 .js），
//                           客户端半 `dist/client.cjs`（tsdown 打的完整工厂）。
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

/** 发布出口：lib（宿主）+ dist（客户端半，只给 CJS——ESM 那份是薄壳，浏览器里解析不到）。 */
const publishExports = {
  '.': './lib/index.js',
  './browser': './lib/browser/runtime.js',
  './browser-electron': './lib/browser-electron/entry.js',
  './tool-browser': './lib/tool-browser/index.js',
  './startpage': './lib/startpage.js',
  './client': './dist/client.cjs',
  './cordis.patch.yml': './cordis.patch.yml',
  './package.json': './package.json',
}

manifest.exports = devExports
manifest.publishConfig = { exports: publishExports }
// `CHANGELOG.md` 必须在 `files` 里：这个数组每次构建都被本脚本重写，历史上因此一直把它漏在包外，
// 结果是 0.6.0 之后更新日志既不在包里、也无处可查（迁入 monorepo 后就断档了）。
// `README.md` / `docs` / `skills` / `assets` 同理：迁移时它们没被带过来，包内因此既没有门面文档，
// 也没有随包发布的技能卡与截图。
// `desktop-bridge` 是最要命的一项：`bridge-install.ts`、`bridge-maintenance.ts`、`bridge-status.ts`
// 与 `automatic-maintenance.ts` 全都按 `../../desktop-bridge/…` 取安装器、桥本体与两个 PowerShell 脚本，
// 少了它桌面端的桥接功能在安装后就是坏的（缺文件，不是逻辑问题）。
// `tests` 不进包（发布不需要），它跑在仓库里。
manifest.files = ['lib', 'dist', 'src', 'scripts', 'tools/accept-desktop.mjs', 'desktop-bridge', 'dsh-host-patch', '!dsh-host-patch/sources', 'browser-extension', 'native-host', 'cordis.patch.yml', 'CHANGELOG.md', 'README.md', 'docs', 'skills', 'assets', '!src/**/__tests__']

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log('exports 已写回：dev→src（源码），publish→lib + dist/client.cjs')
