# 开发

## 构建与测试

```sh
npm run build     # 类型检查 + 构建到 lib/
npm test          # tsc -p tsconfig.json + node --test "tests/*.test.mjs"
```

测试用**假 host**(`tests/` 里的 stub),**不需要 Electron、也不需要网络** —— 所以它可以在 CI 与任何开发机上跑。

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

## 关于 peer 范围的 semver 语义

插件声明 `>=0.1.1-rc.2 <0.3.0`。这个范围在 **semver 默认语义**下**不匹配**任何带预发布标签的版本(如 `0.2.1-alpha.1`)—— 这是规范行为:预发布只被"同一 major.minor.patch 元组"的比较器允许。

DSH 判定插件兼容性时用的是 `includePrerelease: true`(`packages/boot/app-boot/src/plugin-compatibility.ts`),因此这些预发布宿主**实际都在范围内**。若某个外部工具用默认语义得出"不兼容",那是它的语义与 DSH 不同,不是这里的声明写错了。
