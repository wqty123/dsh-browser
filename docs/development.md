# Host TypeScript checks in a DSH workspace

`tsconfig.build.json` checks plugin sources strictly against SDK declarations.
`exclude` cannot exclude an imported upstream `.ts` file, and `skipLibCheck`
only skips declarations, not implementation sources. A workspace checkout
therefore needs compiled SDK declarations or an isolated published SDK install.

If workspace packages resolve to `vendor/deepseek-harness/**`, install the
published SDK contracts in the plugin directory (one command, also in PowerShell):

```sh
npm install --prefix .dsh-sdk-types --ignore-scripts --no-package-lock --no-audit --no-fund @deepseek-ai/cordis@4.1.0 @deepseek-ai/schemastery@3.19.0 @deepseek-ai/dsh-brand@0.2.2-rc.5 @deepseek-ai/dsh-llm@0.2.2-rc.5 @deepseek-ai/dsh-tools@0.2.2-rc.5 @deepseek-ai/dsh-system-prompt@0.2.2-rc.5 @deepseek-ai/dsh-settings@0.2.2-rc.5
node_modules/.bin/tsc --noEmit -p tsconfig.build.json
```

The ignored `.dsh-sdk-types` directory takes priority over workspace packages
for type resolution only; runtime imports and the upstream checkout are not
modified. This validates the plugin against **0.2.2-rc.5** contracts, not against
arbitrary unreleased workspace changes. Refresh these pins when intentionally
validating a different published SDK. A standalone installation whose normal
`node_modules` already contains SDK declarations does not need the extra install.
Without declarations in either location, TypeScript can still fall back to
workspace source exports; do not interpret `skipLibCheck` as isolation in that case.

# 开发

The supported package is sidebar-only: neither `./host-main` nor
`RemoteElectronViewHost` is a public export. Legacy standalone sources remain
for protocol regression tests, not as a missing-sidebar fallback. Native windows
are not reopened automatically. Browser launches never add `--no-sandbox`;
environments that cannot run Chromium sandboxed must fail rather than silently
weaken isolation. Diagnostics use the same resolved DSH home as plugin state:
`<DSH_HOME or ~/.dsh>/logs/dsh-builtin-browser-host.log`.

The behavior tests require Node.js 22.13 or later (including 22.20), which provides
`node:module.stripTypeScriptTypes` for the client-only fixtures. There is no Node
engine pin or checked-in CI workflow in this package. Tests use the installed
`tsc` CLI for declaration checks, not the TypeScript JavaScript compiler API;
this supports both TypeScript 5 and TypeScript 7 installations.

### Remote preview admission and SDK evidence

Preview frame and session-list routes use Connection's documented
`requestRejection(request)` API, the same live-Peer/Host/Origin admission used
by DSH's API carrier. `authorizeIndex` is only a frontend login gate: it does
not apply that Host/Origin fence. An unpaired request returns 401, a rejected
authority/origin returns 403, and a host lacking API admission returns 503
(`browser-pairing-unavailable`), without listing sessions or capturing a frame.
There is no index-cookie-only or loopback bypass. The operator must first use
DSH's authenticated application URL to establish its host-signed browser
session; the plugin neither creates pairing tokens nor implements its own login.

`remoteView.enabled` is still required after host admission. Captures remain
passive and request-driven: listing sessions does not capture, and a frame
request does not select a conversation, initialize a guest, or focus a window.
Quiet automation can attach to the displayed conversation without OS activation;
an undisplayed conversation must be selected by the human first. Explicit
navigation/tab selection may select a tab inside that conversation's sidebar.

To exercise the **actual published rc.5 Connection runtime**, separately from
the declaration check above, install it in an isolated directory and build the
plugin's host JavaScript:

```sh
npm install --prefix .dsh-sdk-types --ignore-scripts --no-package-lock --no-audit --no-fund @deepseek-ai/dsh-client-connection@0.2.2-rc.5 @deepseek-ai/cordis@4.1.0
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/verify-preview-sdk.mjs .dsh-sdk-types
```

The probe uses a real Cordis/Connection instance with an in-memory credential
store and a loopback HTTP listener. It exchanges the host's launch token for a
signed browser cookie without printing either, then checks unpaired, paired,
cross-origin and disposed-host responses. The browser is a recording stub:
this is host-contract evidence, not a Desktop/Web rendering or Mac focus test.
Neither widened `engines.dsh` nor these checks prove compatibility with every
DSH prerelease. A real native-sidebar keyboard reproduction on Mac remains required.

## 构建与测试

在依赖已就绪的 DSH workspace 使用 Node.js 22.13 或更新版本。从插件包目录运行：

```sh
node scripts/build.mjs
node tests/run.mjs
node tests/run.mjs tests/code-tool.test.mjs
```

行为测试需要 `tsx`（或 `ts-node/esm`）来加载宿主依赖；在 monorepo 外不能直接解析 `workspace:^`。先看本文开头的已发布 SDK 类型检查方法。插件不随包安装 Electron；浏览器内核由宿主提供，不要放开全局依赖脚本来绕过审批。

### 1.0.0 回归范围

| 场景 | 需要复验 |
| --- | --- |
| Desktop 侧栏 | 打开原生视图、切换对话、缩放面板、打开并关闭 opener 子标签；验证清理只作用于拥有者，不出现独立窗口。 |
| Desktop 桥接 | 在受支持的 Windows / macOS 安装验证退出确认、重装、恢复和重启状态；不匹配的文件或备份不得被改写。 |
| Web 隔离 | 复查普通子标签与不支持的 opener、引用送入对话和原文回跳，以及宿主凭据不可达。 |
| 批处理 | 核对常用工具与按组加载、PTC 注册条件、独立读取与有序动作、同任务并发单元、取消前输出及多行代码。 |

单元测试并不等于安装包验收。需要原生组合、系统焦点或安装退出流程的场景，要用实际运行的对应宿主复验。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `src/browser/` | `ctx.browser` seam 与全部请求/结果类型 |
| `src/browser-electron/` | provider、桌面侧栏桥、Chrome / Edge 载体、Web guest 代理、设置与历史 |
| `src/tool-browser/` | 模型侧 `dsh_browser_*` 工具;元素/节点字段集 `element-fields.ts`(item schema 与投影同源,一处声明) |
| `src/types/` | electron 环境类型(shim,避免强制依赖 electron 类型) |
| `desktop-bridge/` | 装进桌面端的那条 bridge 与幂等安装脚本(`install.mjs`) |
| `tools/` | 运维脚本(如 `install-web-plugin.mjs`:钉版本 → 安装 → 修复 profile → 复验) |
| `docs/` | 本套文档 |

## 复验宿主兼容性

DSH 升级后想确认"有没有把我们弄坏",不用启动浏览器:

```sh
node scripts/verify-host-compat.mjs
```

它用某个 profile 里**真实安装**的 `@deepseek-ai/*` 包组装一个宿主,加载本插件的编译产物、经宿主自己的 `defineTool` 注册工具、再用一个假 provider 真调两个工具(`dsh_browser_session` / `dsh_browser_a11y`)。默认读 `$DSH_HOME/profiles` 下的 profile,可用 `DSH_PROFILE` / `DSH_HOME` 指定。

### 复验设置页的两个新端点(0.5.6)

```sh
node scripts/verify-runtime-status.mjs        # 与上面同一个 profile 解析规则
```

单元测试覆盖了处理器与判定逻辑,但覆盖不到**接线**:`ctx.inject(['webServer'])` 里注册的两个路径、以及把设置文档与安装树读进报告的 deps。路由没有注册与路由返回空,看起来是一样的 —— 这个探针用真实宿主包组装 cordis context、注册一个记录式 `webServer`、把插件注册的处理器挂到真实 loopback HTTP 上再发请求,断言四件事:两个路径都注册了、`GET` 返回可渲染的报告、无浏览器头的 `POST` 被 403 拒绝、面板式请求能拿到 `provision` 状态。它在**临时 `DSH_HOME`** 里跑,并固定 `ELECTRON_SKIP_BINARY_DOWNLOAD`,所以不会碰用户的设置文件,也不会触发 100 MB 下载。

`node scripts/consumer-install-check.mjs <tgz> <空目录>` 则是安装侧的那一条:默认 pnpm 下装 tarball,**无 `Ignored build scripts`**、`scripts` 恰好是 `build,prepack,test`、就绪端点所在的两个 `lib/` 文件在装出来的树里。

## 关于 DSH 版本范围

插件在 **`engines.dsh`** 里声明 `>=0.1.1-rc.2 <0.3.0`。

位置不是随便选的。DSH 从 0.2.1-alpha.3 之后改成:**有 `engines.dsh` 就只看它,`@deepseek-ai/dsh*` 的 `peerDependencies` 被忽略;没有 `engines.dsh` 才回退到 peer 规则**(`packages/boot/app-boot/src/plugin-compatibility.ts`;官方迁移指南在 `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/`)。

本插件 0.4.12 之前把范围写在 `dsh.compatibility.dsh` 里 —— 那个位置**没有任何代码读取**,当时的兼容性实际是靠 peer 回退蒙对的。迁入 monorepo 后,peers 使用 `workspace:^` 追踪宿主工作区;它不是宿主运行时版本范围,不应拿来覆盖 `engines.dsh`。发布形式若使用显式版本范围,应与这里的运行时兼容声明一致。当前工作区宿主 `0.2.2-rc.3` 和上述历史版本都在声明范围内。

这个范围在 **semver 默认语义**下**不匹配**任何带预发布标签的版本(如 `0.2.1-rc.1`)—— 规范如此:预发布只被"同一 major.minor.patch 元组"的比较器允许。

DSH 判定时用的是 `includePrerelease: true`,因此这些预发布宿主**实际都在范围内**。若某个外部工具用默认语义得出"不兼容",那是它的语义与 DSH 不同,不是这里的声明写错了。

`engines.dsh` 里不接受 `workspace:` 值(只有 peers 接受);写成那样等于声明不兼容。
