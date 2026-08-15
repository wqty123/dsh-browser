# dsh-builtin-browser（DeepSeek Harness 内置共享真实浏览器插件）

[English](README.en.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**共享真实浏览器**能力插件:装好即可用——agent 通过 CDP 驱动一个真实、可见、可随时人工接管的浏览器,人与 agent 操作的是**同一个页面**。

**我们的优势**

- **装好即用**:有桌面外壳时嵌入外壳视图;纯 `dsh web` 也能**自托管**拉起自己的 Electron 窗口,不需要任何额外配置。
- **真实可见、人工可接管**:不是无头截屏或转播,用户随时能看到页面并直接接手操作。
- **DOM 级驱动,框架友好**:React/Vue 受控组件也能可靠填写。
- **并发安全**:任务级浏览器会话隔离,多个任务并行互不抢页面、不互相污染。
- **面向真实世界**:人机验证识别、登录态持久化、批量填表、带登录态下载、操作回放、动作限制,一应俱全。

## 功能

**浏览器能力**

- **真实视图,而非转播。** 浏览器是原生视图(`WebContentsView`),用户可直接看到并操作;agent 驱动的是同一个页面。视图由宿主外壳提供,插件负责驱动。
- **DOM 引用,而非猜坐标。** `browser_snapshot` 返回带编号的交互元素;`browser_execute` 在页面里执行 JS(框架输入用原生 setter),在 React/Vue 页面上也能可靠交互。
- **多标签会话。** 并行打开 URL、查看/切换/关闭/重置标签,状态保持。
- **多格式内容。** 以 html / markdown / txt / json 抓取页面,支持 selector 限定、长度与超时上限。

**工程化能力**

- **按任务隔离。** 每个 DSH 任务(会话)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰;同一任务内多次调用复用同一会话(`browser_session` / `browser_reset_session`)。
- **登录态持久化。** `browser_auth` 导出/恢复 cookie,重启后登录态不丢。
- **人机验证识别。** 自动检测 Cloudflare / reCAPTCHA / hCaptcha / Turnstile 等挑战(`browser_challenge`,快照也会标注),提示人工在共享窗口完成,不再盲目重试。
- **批量表单填充。** `browser_fill` 一次填写多个字段:按选择器/名称/标签匹配,支持受控输入、下拉、单选/复选,可选提交。
- **操作历史与回放。** `browser_history` 记录操作日志,`browser_replay` 可回放某一步。
- **带登录态下载。** `browser_download` 用会话 cookie 把文件取到本地,登录后内容可直接落盘。
- **安全限制。** `browser_restrict` 限制允许的浏览器动作,防误点/误导航。

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
| dsh-builtin-browser | `0.1.7` |
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
| `browser_fill` | 批量填充表单(选择器/名称/标签匹配,支持受控输入、下拉、单选/复选,可选提交) |

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
- 自托管截图优先走 Electron 原生 `capturePage`(CDP `captureScreenshot` 在多视图下会挂起);截图前自动把目标标签置顶。
- **Electron 版本建议 ≥ 40**:33.x 存在合成器缺陷,会间歇性导致截图失败("display surface not available")。插件会**自动选择环境中最新版本的 Electron**(peer 依赖 > `ELECTRON_PATH` > 锚点/pnpm store 中最新版)。
- 部分主机在软件合成下 `fullPage` 截图不稳定。
- 会话按任务隔离:每个调用方任务(DSH 会话)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰;同一任务的多次调用复用同一会话。登录态(cookie)为共享,可用 `browser_auth` 导出/恢复。
- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战(`browser_challenge` 可显式检查),此时应请用户在共享窗口中人工完成,而不是反复重试。
- 无痕模式(`privateMode`)未实现:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- `browser_download` 在页面上下文内 `fetch`(带登录态),受同源/CORS 约束;单文件上限 256MB。
- `browser_auth` 的 cookie 往返不保留 `hostOnly`/`sameSite` 字段(host-only cookie 恢复后变成 domain cookie);仅自托管浏览器可用。
- 自托管浏览器子进程崩溃后会自动重启,但崩溃前已打开的会话视图已失效,调用 `browser_reset_session` 重建即可。
- 本插件不含浏览器列 UI——那是宿主外壳的配套,别把"浏览器列"当成插件能力。

## 许可证

MIT
