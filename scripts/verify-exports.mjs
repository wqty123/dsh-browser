// 出口守卫：在构建结束时断言两套出口与 DSH 0.2.3 客户端产物信封形态，避免「dev 指向打包产物」
// 或「旧自注入 <style> 逻辑回流」等问题再次复发。
import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
const problems = []

if (manifest.exports?.['./host-main'] !== undefined || manifest.publishConfig?.exports?.['./host-main'] !== undefined) {
  problems.push('standalone host-main must not be exported by the sidebar-only package')
}

const devClient = manifest.exports?.['./client']
const publishClient = manifest.publishConfig?.exports?.['./client']

if (typeof devClient !== 'string' || !devClient.endsWith('src/client/index.ts')) {
  problems.push(`exports['./client'] 必须指向源码（当前 ${JSON.stringify(devClient)}）：dev 由宿主打包链处理客户端半，`
    + '指向打包产物会让浏览器在 `window.__ModuleLoader__` 就绪前加载 CJS 工厂并抛 `Cannot read properties of undefined (reading \'load\')`')
}
if (publishClient !== './lib/client.js') {
  problems.push(`publishConfig.exports['./client'] 必须是 ./lib/client.js（当前 ${JSON.stringify(publishClient)}）`)
}
if (typeof manifest.exports?.['.'] !== 'string' || !manifest.exports['.'].endsWith('src/index.ts')) {
  problems.push('exports[\'.\'] 必须指向源码 src/index.ts（dev 形态）')
}
if (manifest.publishConfig?.exports?.['.'] !== './lib/index.js') {
  problems.push("publishConfig.exports['.'] 必须是 ./lib/index.js（tsc 产物；打包产物会残留 .ts 说明符）")
}

const clientBundleUrl = new URL('../lib/client.js', import.meta.url)
if (!existsSync(clientBundleUrl)) {
  problems.push('lib/client.js 缺失：构建未产出 DSH 0.2.3 客户端工厂')
} else {
  const clientCode = readFileSync(clientBundleUrl, 'utf8')
  const expectedBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`
  if (!clientCode.startsWith(expectedBanner)) {
    problems.push(`lib/client.js 必须以 ${expectedBanner} 开头`)
  }
  if (!clientCode.includes('meta: () => ({ stylesheets:')) {
    problems.push('lib/client.js 必须通过 meta: () => ({ stylesheets: ... }) 向宿主移交样式表')
  }
  if (clientCode.includes('data-plugin-css')) {
    problems.push('lib/client.js 不得残留旧版运行期 <style data-plugin-css> 自注入逻辑')
  }
}

const distDir = new URL('../dist/', import.meta.url)
for (const forbidden of ['client.cjs', 'client.mjs', 'client.mjs.map']) {
  if (existsSync(new URL(forbidden, distDir))) {
    problems.push(`dist/${forbidden} 必须不存在：客户端产物已统一切至 lib/client.js`)
  }
}

if (problems.length > 0) {
  console.error('[exports-guard] 出口或客户端产物形态不合格：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('[exports-guard] 通过：dev→src / publish→lib + lib/client.js（0.2.3 信封与 meta().stylesheets）')
