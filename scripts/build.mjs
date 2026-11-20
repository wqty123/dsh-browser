// 构建入口：宿主侧用 tsc 编到 `lib/`（类型错误不阻断——迁移来的源码在更严格的配置下仍有既有类型问题，
// 但这些文件本来就能跑，发布形态由 0.5.8 验证过），客户端半交给 tsdown，最后收尾出口并守卫形态。
//
// 顺序有意为之：**先删 ESM 薄壳，再守卫**，否则守卫会在删除前就看到残留而误报。
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()

/**
 * 跑一条 node 命令并打印输出。
 * @param args - node 的参数（第一个是脚本路径）。
 * @param allowFailure - 非零退出是否可接受。
 */
function runNode(args, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  const code = result.status ?? 1
  if (code !== 0 && !allowFailure) {
    console.error(`[build] node ${args.join(' ')} 失败，退出码 ${code}`)
    process.exit(code)
  }
}

/**
 * 定位包内可执行脚本（向仓库根方向查找 node_modules）。
 * @param relative - 相对 node_modules 的路径。
 * @param packageName - 包名，用于报错。
 * @returns 绝对路径。
 */
function entryOf(relative, packageName) {
  let dir = cwd
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  console.error(`[build] 找不到 ${packageName} 的入口（已向上查找 6 层）：node_modules/${relative}`)
  process.exit(1)
}

// 1) 宿主侧：tsc → lib/（`rewriteRelativeImportExtensions` 把 `./x.ts` 改写成 `./x.js`）
runNode([entryOf('typescript/bin/tsc', 'typescript'), '-p', 'tsconfig.build.json'], true)

// 2) 客户端半：tsdown → dist/client.cjs（另有一份无用的 ESM 薄壳，第 3 步删掉）
runNode([entryOf('tsdown/dist/run.mjs', 'tsdown')])

// 3) 删掉客户端 ESM 薄壳：内容是 `export { apply, inject } from "./client/index.ts"`——按源码路径
//    转发，被 vite 加载即 `Failed to resolve import`，整页被遮罩。发布只用 dist/client.cjs。
for (const file of [join(cwd, 'dist', 'client.mjs'), join(cwd, 'dist', 'client.mjs.map')]) {
  if (existsSync(file)) {
    rmSync(file, { force: true })
    console.log(`[build] 已删除客户端 ESM 薄壳：${file}`)
  }
}

// 4) 出口收尾：写回 dev→src / publish→lib+dist 的两套出口（构建链会覆盖 exports）
runNode(['scripts/fix-exports.mjs'])

// 5) 出口守卫：形态不合格直接失败（含「dev 指向 dist」这条反复出过的事故）
runNode(['scripts/verify-exports.mjs'])

console.log('[build] 完成：lib/<宿主侧> + dist/client.cjs<客户端半>')
