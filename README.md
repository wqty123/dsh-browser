# dsh-builtin-browser（DeepSeek Harness 内置共享真实浏览器插件）

[English](README.en.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的共享真实浏览器能力插件:一个用户可见、可随时接管的浏览器,由 agent 通过 CDP 驱动。

本插件提供 **host 侧能力**(浏览器 seam、Electron CDP provider、`browser_*` 模型工具)。浏览器本身的**原生视图**由宿主(桌面外壳)通过 `ctx.electronViewHost` 提供;插件不包含浏览器界面 UI。

## 功能

- **真实视图,而非转播。** 浏览器是原生视图(`WebContentsView`),用户可直接看到并操作;agent 驱动的是同一个页面。视图由宿主外壳提供,插件负责驱动。
- **DOM 引用,而非猜坐标。** `browser_snapshot` 返回带编号的交互元素;`browser_execute` 在页面里执行 JS(框架输入用原生 setter),在 React/Vue 页面上也能可靠交互。
- **多标签会话。** 并行打开 URL、查看/切换/关闭/重置标签,状态保持。
- **多格式内容。** 以 html / markdown / txt / json 抓取页面,支持 selector 限定、长度与超时上限。

## 环境要求

- DeepSeek Harness(dsh)且安装了 `web` profile
- **Electron 运行时**(可选 peer 依赖):桌面外壳自带;纯 `dsh web` 下需要能定位到 Electron 二进制(见下)
- 有桌面外壳(`ctx.electronViewHost`)时用外壳嵌入视图;没有时插件**自托管**:自己拉起一个 Electron 窗口,`browser_*` 工具照常可用

**Electron 定位顺序**:① `require('electron')`(peer 依赖已装)→ ② DSH 安装锚点 → ③ `node_modules/.pnpm` 虚拟仓库 → ④ `ELECTRON_PATH` 环境变量。找不到时工具会报清晰的错误提示。

### 验证过的版本

| 组件 | 版本 |
|---|---|
| DeepSeek Harness(dsh) | `0.1.0-rc.5` |
| Electron | `43.4.0` |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.3` |
| 操作系统 | Windows 10 (10.0.26200) |

> 插件声明 `electron >= 30`;其他平台(如 macOS/Linux)按同一协议运行,但仅在上表 Windows 环境实测。

## 安装

```sh
dsh plugin --profile web add dsh-builtin-browser   # 发布到 npm 后
# 或从源码目录(独立仓库,一插件一仓库):
dsh plugin --profile web add <本仓库路径>
```

这会链接插件、把 `dsh-builtin-browser` 加入 profile 的 bundle 层,并挂载:

| 行 | 子路径 | 角色 |
|---|---|---|
| `browser` | `dsh-builtin-browser/browser` | `ctx.browser` 能力 seam(始终挂载) |
| `browser-electron` | `dsh-builtin-browser/browser-electron` | Electron CDP provider(需要 `electronViewHost`) |
| `tool-browser` | `dsh-builtin-browser/tool-browser` | `browser_*` 模型侧工具 |

provider 与工具以 `ctx.get('electronViewHost')` 是否存在为门控,因此没有桌面外壳的组合只会保留 seam,其余不启用。

## 配置

插件通过 `cordis.patch.yml` 挂载,各行的配置:

| 行 | 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `browser-electron` | `viewHost` | 对象 | 必填 | 宿主提供的 `ElectronBrowserViewHost` 实例(通常 `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;其余协议(如 `file:`/`data:`)拒绝(`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数,超出截断 |
| `browser-electron` | `contentMaxChars` | 数字 | `100000` | 内容抓取默认字符上限 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具(`browser_list_tabs` 等) |

## 工具

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 URL(可选新标签);返回快照 |
| `browser_snapshot` | 交互元素(输入框/按钮/链接)带编号清单 |
| `browser_execute` | 在页面执行 JS;参数以 `arguments[0..n]` 传入 |
| `browser_content` | 以 html / markdown / txt / json 抓取页面(selector、maxChars、timeoutMs) |
| `browser_screenshot` | PNG 截图,可选 `fullPage` |
| `browser_list_tabs` / `browser_switch_tab` / `browser_close_tab` / `browser_reset` | 多标签会话管理 |
| `browser_session` / `browser_reset_session` | 查看/重置当前任务的浏览器会话(按任务隔离) |
| `browser_history` / `browser_replay` | 查看操作记录并回放某一步 |
| `browser_download` | 带会话 cookie 下载 URL 到本地文件 |
| `browser_restrict` | 限制允许的浏览器动作,防误点/误导航 |
| `browser_auth` | 导出/恢复 cookie,持久化登录态 |
| `browser_challenge` | 检测人机验证(CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile)是否拦截当前页 |

### 操作纪律(点击/填表)

- **优先用 DOM 语义而非坐标**:表单提交优先 `form.requestSubmit()`;点击优先 `element.click()`;坐标点击是最后手段。
- **选中正确的元素**:页面常有隐藏副本(如移动端按钮),用 `browser_execute` 过滤可见元素(`getBoundingClientRect()` 宽高 > 0、`getComputedStyle` 非 `display:none`),再取坐标。
- **取坐标后立即点击**:中间不要插入其他操作(填表、滚动会移动元素,旧坐标立即失效)。
- **点击前验证命中**:`document.elementFromPoint(x, y)` 确认该坐标确实是目标元素(按钮/链接),再执行真实点击。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

## 工作原理

```
agent (browser_* 工具)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (由宿主外壳提供)
  → WebContentsView + webContents.debugger (CDP)
```

provider 按构造与 Electron 解耦:它通过 `ElectronBrowserViewHost` 接缝操作(创建/销毁/显示视图、`sendCommand`),由真实外壳用 Electron 对象实现。同一接缝也让未来的转播 provider(无头 Chromium 截图流)服务远程部署,而无需改动工具。

## 与桌面外壳的分工

浏览器**可见视图**、**浏览器列布局**、**列与视图的对齐**都属于宿主外壳(如 dsh 的 `apps/desktop`),不在本插件内。本插件只消费外壳提供的 `electronViewHost`,负责 seam、provider 与工具。若你只装插件而没有配套外壳,插件功能保持禁用。

## 已知限制

- 截图仅 PNG(CDP JPEG 在 Electron 43 上挂起);JPEG 等待非 CDP 转换路径。
- 部分主机在软件合成下 `fullPage` 截图不稳定。
- 会话按任务隔离:每个调用方任务(DSH 会话)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰;同一任务的多次调用复用同一会话。登录态(cookie)为共享,可用 `browser_auth` 导出/恢复。
- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战(`browser_challenge` 可显式检查),此时应请用户在共享窗口中人工完成,而不是反复重试。
- 无痕模式(`privateMode`)未实现:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- 本插件不含浏览器列 UI——那是宿主外壳的配套,别把"浏览器列"当成插件能力。

## 许可证

MIT
