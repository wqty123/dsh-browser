import { defineConfig } from "tsdown";
import { cordisPlugin } from "@local/tsdown-plugin-cordis";

// 迁移自成熟的 `dsh-builtin-browser@0.5.8`。**一个包交付全部能力**，两侧产物分开出：
//
//   宿主侧 → `tsc -p tsconfig.build.json` 编到 `lib/`（与 0.5.8 的发布形态一致）
//     - `lib/index.js` 根行（惰性；也让宿主扫描到本包的 `dsh.client`）
//     - `lib/browser/runtime.js` `ctx.browser` 服务
//     - `lib/browser-electron/entry.js` 载体 + 代理路由 + 设置文档路由
//     - `lib/tool-browser/index.js` 面向模型的 `dsh_browser_*` 工具
//     - `lib/browser-electron/host-main.js` Electron 主进程入口
//     - `lib/startpage.js` 起始页宿主伴生条目（注册 `browser-startpage` 设置分节）
//
//   客户端侧 → 这里的 tsdown 只打客户端半（它要在浏览器里作为单文件 CJS 工厂运行）
//     - `dist/client.cjs` / `dist/client.mjs`
//
// 为什么宿主侧不用 tsdown 打包：源码里的相对引用是 `.ts` 说明符（dev 宿主直接加载 TS 源码所需），
// 打包后这些说明符会原样留在产物里，运行期去 `dist/` 找 `.ts` 文件必然 `ERR_MODULE_NOT_FOUND`
// ——桌面端五个入口全挂就是这么来的。`tsc` + `rewriteRelativeImportExtensions` 会把它们改写成 `.js`。
export default defineConfig({
  dts: false,
  // 外部依赖边界由 `cordisPlugin()` 的 `deps.neverBundle` 统一声明（`@deepseek-ai/*`、react 等），
  // 这里不再重复给 `external`：tsdown 0.23 起两者同时出现会直接报冲突。
  plugins: [
    cordisPlugin({
      client: {
        name: "dsh-builtin-browser",
        entry: "./src/client/index.ts",
      },
    }),
  ],
});
