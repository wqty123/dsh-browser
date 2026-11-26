# Devin 任务规范：PR-4 `dsh-host-patch` 适配 `dsh-v0.2.3-alpha.2`

> **说明**：本分支已完成 PR-4 中的 `ctx.browserUse` 可选独占注册及单测（`src/browser/runtime.ts`、`tests/browser-use-registration.test.mjs`）。
> `dsh-host-patch` 依赖从 npm registry 拉取真实构建的 `0.2.3-alpha.2` 产物计算 SHA-256 与唯一锚点，请 Devin 在具备 npm 联网能力的环境中直接在本分支（或从 `master` 切新分支）补齐以下改动并确保 CI 全绿。

## 1. 提取真实 `0.2.3-alpha.2` 宿主产物
在临时目录通过 `npm pack` 提取以下两个包的真实发布产物（严禁手工猜测哈希或锚点）：
1. `@deepseek-ai/dsh-client-ui-sidebar-right@0.2.3-alpha.2`
   - 目标文件：`lib/client.js`
2. `@deepseek-ai/dsh-desktop@0.2.3-alpha.2`
   - 目标文件：`lib/main.js`、`lib/preload-app.cjs`

## 2. 核对上游变化并生成 `dsh-host-patch/v023-alpha2.json`
对照 `dsh-host-patch/rc5.json` 逐项核对 3 个目标文件：
1. **`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`**
   - 核对 `openReservedTab`、`holdRendering`、`SidebarNativeComposition`、背景渲染样式等是否已被 0.2.3 上游原生吸收（已原生支持的片段直接跳过，避免重复注入）。
   - 0.2.3 将 CSS Modules 迁入 `meta().stylesheets`，不再存在旧版 `const css="..."` 变量：
     - 重新定位背景渲染样式锚点；
     - 核验 `dsh-host-patch/apply.mjs` 中 `substitutions()` 的正则 `/\.([A-Za-z0-9_-]+)_session\{display:contents\}/g` 在 0.2.3 的 `meta().stylesheets` 字符串内是否依然**唯一命中**（如因转义或压缩变化需同步调整）。
2. **`@deepseek-ai/dsh-desktop/lib/main.js`** & **`lib/preload-app.cjs`**
   - 计算真实 pristine 文件的 `sha256` 写入 `v023-alpha2.json`；
   - 校准 `startDesktopMainExtensions`、`DesktopNativeViews`、`SidebarSessionCookies`、`DESKTOP_IPC`、`nativeViews`、`childTabs`、`mainExtensions`、`persistentSession` 等唯一锚点。
3. **注册进 `dsh-host-patch/apply.mjs`**
   - 将 `'v023-alpha2'` 加入 `specs` 数组（`version: "0.2.3-alpha.2"`）。
4. **核对 `src/browser-electron/host-patch-maintenance.ts`**
   - 确认 `clientModules.clientPath(sidebar)` 与 `modules.rebuilt(sidebar)` 在 0.2.3 宿主上的调用签名无破坏性变化（如有变更同步适配）。

## 3. 验收标准
- 对真实提取出的 `0.2.3-alpha.2` 包目录执行：
  - `node dsh-host-patch/apply.mjs status <pkgDir>` → `status: "absent"`
  - `node dsh-host-patch/apply.mjs apply <pkgDir>` → `status: "applied", changed: true`
  - `node dsh-host-patch/apply.mjs status <pkgDir>` → `status: "applied"`
  - `node dsh-host-patch/apply.mjs restore <pkgDir>` → `status: "absent", changed: true` 且文件与原始字节 100% 一致
- 全量单测（含 `tests/host-patch-installer.test.mjs`、`tests/web-host-patch.test.mjs`、`tests/browser-use-registration.test.mjs`）与 `node tools/check-pack.mjs` 通过。
