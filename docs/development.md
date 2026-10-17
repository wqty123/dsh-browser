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

## 关于 DSH 版本范围

插件在 **`engines.dsh`** 里声明 `>=0.1.1-rc.2 <0.3.0`。

位置不是随便选的。DSH 从 0.2.1-alpha.3 之后改成:**有 `engines.dsh` 就只看它,`@deepseek-ai/dsh*` 的 `peerDependencies` 被忽略;没有 `engines.dsh` 才回退到 peer 规则**(`packages/boot/app-boot/src/plugin-compatibility.ts`;官方迁移指南在 `docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/`)。

本插件 0.4.12 之前把范围写在 `dsh.compatibility.dsh` 里 —— 那个位置**没有任何代码读取**,当时的兼容性实际是靠 peer 回退蒙对的。现在两处一致(`engines.dsh` 与 peers 同范围),所以哪条规则生效都得到同一个答案。

这个范围在 **semver 默认语义**下**不匹配**任何带预发布标签的版本(如 `0.2.1-rc.1`)—— 规范如此:预发布只被"同一 major.minor.patch 元组"的比较器允许。

DSH 判定时用的是 `includePrerelease: true`,因此这些预发布宿主**实际都在范围内**。若某个外部工具用默认语义得出"不兼容",那是它的语义与 DSH 不同,不是这里的声明写错了。

`engines.dsh` 里不接受 `workspace:` 值(只有 peers 接受);写成那样等于声明不兼容。
