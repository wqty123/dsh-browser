# 开发

## 构建与测试

```sh
pnpm install --frozen-lockfile --ignore-scripts  # CI 使用 pnpm 11.7.0,不下载 Electron 二进制
npm run build     # 类型检查 + 构建到 lib/
npm test          # tsc -p tsconfig.json + node --test "tests/*.test.mjs"
```

测试用**假 host**(`tests/` 里的 stub),**不需要 Electron、也不需要网络** —— 所以它可以在 CI 与任何开发机上跑。

本插件从 0.4.16 起用 `postinstall` 调用 `scripts/install-electron.mjs`,明确解析所依赖 electron 包的 `install.js`。上述 `--ignore-scripts` 会跳过此步骤,适合不启动浏览器的 CI。需要真实浏览器时,可在源码目录运行 `node scripts/install-electron.mjs`,或在安装插件的 profile 目录运行 `npx --no dsh-browser-install-electron`;命令使用本地安装,不应临时下载同名包。它们遵守 `ELECTRON_SKIP_BINARY_DOWNLOAD`,下载失败返回非零并保留错误。

DSH rc.5 的 pnpm 11.7 使用 `strict-dep-builds`,依赖脚本未批准时应经宿主原生插件管理器批准并重试。插件不自动改写 profile 的 `allowBuilds`;不要以全局放开依赖脚本替代宿主审批流程。

## 0.4.16 发布前验证

本仓库正在准备 0.4.16,本地版本号、测试通过或生成 `.tgz` 均不表示已发布。审核与 rc.5 适配记录见 [CHANGELOG](../CHANGELOG.md)。

- `npm test` 覆盖系统浏览器并发选页、保存文件不覆盖、bridge 输入与会话归属、设置失败关闭、历史保留和 rc.5 对应 DOM 结构。假 host 测试不能证明真实浏览器、侧栏或无显示服务器端到端可用。
- 检查可安装包的 `postinstall`、本地 `dsh-browser-install-electron` 命令、宿主构建脚本批准、显式跳过与下载失败返回路径。包管理器许可脚本与网络均满足时才期望自动准备二进制;保留 `--ignore-scripts` 安装测试,避免把 CI 下载成功当作用户侧已经批准脚本。
- 使用锁文件中的 Electron `44.10.0` 做独立用户数据目录的真实烟测:从可安装 `.tgz` 加载插件,验证导航、读页、截图落盘、窗口/进程退出。启动时显式核对 `ELECTRON_PATH`,避免旧覆盖把测试换成其他内核。
- 侧栏需单独检查外壳版本、webview 能力和已部署的 bridge。真实宿主 peer 下的工具注册与假 provider 调用只证明宿主契约;实际侧栏列页、关闭与会话隔离需要独立验证。
- 发布前检查压缩包内容、双语 README 的版本与升级入口,再执行发布流程。仅做本地准备时保留候选状态,不要将发布、部署或真实烟测写成已经完成。

依赖声明 Electron `^44.10.0`,锁文件为 `44.10.0`;安全最低阈值为 `44.9.1`,`undici` override 为 `7.30.1`。升级插件不会替换桌面外壳内核、安装侧 bridge 或用户的环境变量覆盖。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `src/browser/` | `ctx.browser` seam 与全部请求/结果类型 |
| `src/browser-electron/` | provider 与三种载体实现 —— 桌面侧栏桥(`desktop-bridge-host.ts`)、本机浏览器(`system-browser.ts`)、自托管子进程(`host-main.ts`);传输层 `bridge-connection.ts` 与 RPC 操作词汇表 `rpc-ops.ts`;以及设置、历史、虚拟光标 |
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

## 关于 DSH 版本范围

插件在 **`engines.dsh`** 里声明 `>=0.1.1-rc.2 <0.3.0`。

位置不是随便选的。DSH 从 0.2.1-alpha.3 之后改成:**有 `engines.dsh` 就只看它,`@deepseek-ai/dsh*` 的 `peerDependencies` 被忽略;没有 `engines.dsh` 才回退到 peer 规则**(`packages/boot/app-boot/src/plugin-compatibility.ts`;官方迁移指南在 `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/`)。

本插件 0.4.12 之前把范围写在 `dsh.compatibility.dsh` 里 —— 那个位置**没有任何代码读取**,当时的兼容性实际是靠 peer 回退蒙对的。现在两处一致(`engines.dsh` 与 peers 同范围),所以哪条规则生效都得到同一个答案。

这个范围在 **semver 默认语义**下**不匹配**任何带预发布标签的版本(如 `0.2.1-rc.1`)—— 规范如此:预发布只被"同一 major.minor.patch 元组"的比较器允许。

DSH 判定时用的是 `includePrerelease: true`,因此这些预发布宿主**实际都在范围内**。若某个外部工具用默认语义得出"不兼容",那是它的语义与 DSH 不同,不是这里的声明写错了。

`engines.dsh` 里不接受 `workspace:` 值(只有 peers 接受);写成那样等于声明不兼容。
