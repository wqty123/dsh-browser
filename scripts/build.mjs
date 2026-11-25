// 构建入口：宿主侧用 tsc 编到 `lib/`（类型错误不阻断——迁移来的源码在更严格的配置下仍有既有类型问题，
// 但这些文件本来就能跑），客户端半由 `scripts/build-client.mjs` 直接以 DSH 0.2.3 信封形态编到
// `lib/client.js`（`window.__ModuleLoader__.load({ id, factory, meta })` + `meta().stylesheets`），
// 最后收尾出口并守卫形态。
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
runNode(['scripts/bundle-host.mjs'])

// 2) 客户端半：rolldown + lightningcss → lib/client.js（0.2.3 `{ id, factory, meta }` 信封）
runNode(['scripts/build-client.mjs'])

// 3) 清理历史遗留的 dist/client.* 产物，避免旧产物残留在发布包里
for (const file of [
  join(cwd, 'dist', 'client.cjs'),
  join(cwd, 'dist', 'client.mjs'),
  join(cwd, 'dist', 'client.mjs.map'),
]) {
  if (existsSync(file)) {
    rmSync(file, { force: true })
    console.log(`[build] 已清理旧客户端产物：${file}`)
  }
}

// 4) 出口收尾：写回 dev→src / publish→lib 的两套出口
runNode(['scripts/fix-exports.mjs'])

// 5) 出口守卫：形态与信封不合格直接失败
runNode(['scripts/verify-exports.mjs'])

console.log('[build] 完成：lib/<宿主侧> + lib/client.js<客户端半>')
