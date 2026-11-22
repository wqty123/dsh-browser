// 出口守卫：在构建结束时断言两套出口的形态，避免「dev 指向打包产物」这类问题再次复发。
//
// 反复出现过的两个事故：
//   1. dev 出口指向 `dist/client.cjs` → vite 把 CJS 当 ESM 导入，浏览器里 `window.__ModuleLoader__`
//      还是 undefined，整页红屏 `Cannot read properties of undefined (reading 'load')`。
//   2. 包里留着 `dist/client.mjs` → 它是薄壳（`export { apply } from "./client/index.ts"`），
//      被加载时 vite 报 `Failed to resolve import "./client/index.ts"` 并遮住整页。
// 这两条都属于「动作之前的拦截」：构建期直接失败，而不是等运行时红屏。
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
    + '指向 dist 会让浏览器在 `window.__ModuleLoader__` 就绪前加载 CJS 工厂并抛 `Cannot read properties of undefined (reading \'load\')`')
}
if (publishClient !== './dist/client.cjs') {
  problems.push(`publishConfig.exports['./client'] 必须是 ./dist/client.cjs（当前 ${JSON.stringify(publishClient)}）`)
}
if (typeof manifest.exports?.['.'] !== 'string' || !manifest.exports['.'].endsWith('src/index.ts')) {
  problems.push('exports[\'.\'] 必须指向源码 src/index.ts（dev 形态）')
}
if (manifest.publishConfig?.exports?.['.'] !== './lib/index.js') {
  problems.push("publishConfig.exports['.'] 必须是 ./lib/index.js（tsc 产物；打包产物会残留 .ts 说明符）")
}

const distDir = new URL('../dist/', import.meta.url)
for (const forbidden of ['client.mjs', 'client.mjs.map']) {
  if (existsSync(new URL(forbidden, distDir))) {
    problems.push(`dist/${forbidden} 必须不存在：它是按源码路径转发的 ESM 薄壳，被加载即报 Failed to resolve import`)
  }
}

if (problems.length > 0) {
  console.error('[exports-guard] 出口形态不合格：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('[exports-guard] 通过：dev→src / publish→lib+dist/client.cjs，且无 ESM 薄壳')
