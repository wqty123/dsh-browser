<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Platforms">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

<h3 align="center">为 DeepSeek Harness 生态打造的<b>共享真实浏览器</b>插件（装好即用，人机同页）</h3>

<h4 align="center">agent 驱动一个真实、可见、可随时人工接管的浏览器——人与 agent 操作的是<b>同一个页面</b>。</h4>

## 文档

| 目标 | 入口 |
| --- | --- |
| 了解插件为什么存在、与无头方案的区别 | [为什么做共享真实浏览器](docs/why-browser.md) |
| 安装、配置与日常使用 | [用户指南](docs/user-guide.md) |
| 全部 20 个工具的参数、输出与示例 | [工具参考](docs/tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](docs/architecture.md) |
| 查看全部文档与 README 分工 | [文档索引](docs/README.md) |

## 这是什么

`dsh-builtin-browser` 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供浏览器能力:

- **真实视图,而非转播**:浏览器是原生 `WebContentsView`,用户直接看到 agent 在做什么,随时可以上手接管;
- **装好即用**:有桌面外壳时嵌入外壳视图;纯 `dsh web` 也能**自托管**——插件自己拉起一个 Electron 窗口,不需要任何额外配置;
- **一插件即一套工具**:安装后 agent 自动获得 20 个 `browser_*` 工具(打开、查看、操作、填表、截图、下载、登录态管理……)。

一句话:**安装插件 = 获得一个与用户共享、可被 agent 驱动的真实浏览器。**

## 快速开始

```sh
# 方式一:从 npm 安装(已发布)
dsh plugin --profile web add dsh-builtin-browser

# 方式二:从源码目录安装(独立仓库,一插件一仓库)
dsh plugin --profile web add <本仓库路径>
```

安装后,agent 即可使用浏览器工具,例如:

| 想做什么 | 用哪个工具 | 说明 |
| --- | --- | --- |
| 打开页面 | `browser_open` | 打开 URL,返回带编号元素的快照 |
| 了解页面 | `browser_snapshot` | 输入框/按钮/链接的编号清单,可据此定位 |
| 操作页面 | `browser_execute` | 在页面里执行 JS(原生 setter,框架友好) |
| 填写表单 | `browser_fill` | 一次填写多个字段,可选提交 |
| 看到页面 | `browser_screenshot` | PNG 截图,可存文件交给视觉模型 |

完整清单见[工具参考](#工具参考)。

## 主要功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>共享真实浏览器</h3>
      <p>原生视图而非无头截屏。用户与 agent 操作同一个页面:用户能看到每一步,随时接管;agent 驱动的就是用户眼前那个窗口。</p>
    </td>
    <td width="50%" valign="top">
      <h3>DOM 级驱动,框架友好</h3>
      <p><code>browser_snapshot</code> 返回带编号的交互元素;<code>browser_execute</code> 在页面内执行 JS(受控输入用原生 setter + input/change 事件),React/Vue 页面也能可靠交互。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>多标签会话</h3>
      <p>并行打开 URL,查看/切换/关闭/重置标签,每个会话的状态独立保持。</p>
    </td>
    <td width="50%" valign="top">
      <h3>多格式内容</h3>
      <p>以 html / markdown / txt / json 抓取页面,支持 CSS selector 限定、字符上限与超时控制。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>任务级会话隔离</h3>
      <p>每个 DSH 任务(会话)拥有独立的浏览器会话(独立标签页与历史),并发任务互不抢页面、互不污染;同一任务内多次调用复用同一会话。</p>
    </td>
    <td width="50%" valign="top">
      <h3>登录态持久化</h3>
      <p><code>browser_auth</code> 导出/恢复 cookie,重启后登录态不丢;自托管实例的 cookie 本身也落盘持久。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>人机验证识别</h3>
      <p>自动检测 Cloudflare / reCAPTCHA / hCaptcha / Turnstile 等挑战(<code>browser_challenge</code>,快照也会标注),提示人工在共享窗口完成,不再盲目重试。</p>
    </td>
    <td width="50%" valign="top">
      <h3>批量表单填充</h3>
      <p><code>browser_fill</code> 一次填写多个字段:按选择器/名称/标签匹配,支持受控输入、下拉、单选/复选,可选提交;单个字段失败不影响其余字段。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>操作历史与回放</h3>
      <p><code>browser_history</code> 记录操作日志(打开/执行/点击/输入/填表/下载/登录),<code>browser_replay</code> 可按序号回放某一步。</p>
    </td>
    <td width="50%" valign="top">
      <h3>带登录态下载</h3>
      <p><code>browser_download</code> 在页面上下文内携带会话 cookie 拉取文件并落盘,登录后才能访问的内容也能直接下载。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>安全限制</h3>
      <p><code>browser_restrict</code> 限制允许的浏览器动作(白名单),防止 agent 误点、误导航;只读工具(snapshot/content/screenshot)不受限。</p>
    </td>
    <td width="50%" valign="top">
      <h3>截图即存即读</h3>
      <p><code>browser_screenshot</code> 支持 <code>savePath</code> 直接落盘 PNG,交给视觉模型(modlens 等)做基于视觉的元素定位。</p>
    </td>
  </tr>
</table>

## 为什么选它

- **装好即用,零配置**:不需要桌面外壳、不需要额外启动步骤;纯 `dsh web` 环境自托管拉起 Electron 窗口,`browser_*` 工具照常可用。
- **人机协同,互不干扰**:用户能看到并接管 agent 的每一个动作;任务级会话隔离让多个并行任务各自拥有独立的标签页与历史。
- **面向真实世界的自动化**:人机验证识别、登录态持久化、批量填表、带登录态下载、操作回放、动作限制——把"真实浏览器"变成可靠的 agent 能力。
- **可测试、可替换的架构**:provider 与 Electron 通过 `ElectronBrowserViewHost` 接缝解耦,同一套工具层未来可对接无头转播 provider,无需改动模型侧。

## 工具参考

| 工具 | 用途 | 守卫 |
| --- | --- | --- |
| `browser_open` | 打开 URL(可选新标签),返回页面快照 | ✅ |
| `browser_snapshot` | 交互元素(输入框/按钮/链接)带编号清单 | – |
| `browser_execute` | 在页面执行 JS;参数以 `arguments[0..n]` 传入 | ✅ |
| `browser_content` | 以 html / markdown / txt / json 抓取页面(selector、maxChars、timeoutMs) | – |
| `browser_click` | 按视口坐标点击(配合截图做视觉定位) | ✅ |
| `browser_type` | 向聚焦元素输入文本(CDP `Input.insertText`) | ✅ |
| `browser_fill` | 批量填充表单(选择器/名称/标签匹配,受控输入、下拉、单选/复选,可选提交) | ✅ |
| `browser_screenshot` | PNG 截图,可选 `fullPage` 与 `savePath` | – |
| `browser_list_tabs` | 当前会话的标签列表 | – |
| `browser_switch_tab` | 按 id 切换标签(自托管下同步切换可见视图) | ✅ |
| `browser_close_tab` | 按 id 关闭标签;关闭活动标签后激活下一个 | – |
| `browser_reset` | 关闭本任务所有标签,回到一个空白标签 | ✅ |
| `browser_session` | 查看本任务的浏览器会话与标签 | – |
| `browser_reset_session` | 关闭并重建本任务的浏览器会话 | ✅ |
| `browser_history` | 操作日志(最新在后),含成功/失败与结果摘要 | – |
| `browser_replay` | 按序号回放某一步(navigate/execute/click/type) | ✅ |
| `browser_download` | 带会话 cookie 下载 URL 到本地文件(上限 256MB) | ✅ |
| `browser_auth` | 导出/恢复 cookie(登录态持久化,自托管可用) | ✅ |
| `browser_challenge` | 检测人机验证(CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile) | – |
| `browser_restrict` | 限制允许的浏览器动作(白名单;空列表解除) | – |

> 「守卫」列:打 ✅ 的动作受 `browser_restrict` 白名单约束;只读工具(snapshot/content/screenshot/list_tabs/session/challenge/history)永不拦截。

### 操作纪律(点击/填表)

- **优先用 DOM 语义而非坐标**:表单提交优先 `form.requestSubmit()`;点击优先 `element.click()`;坐标点击是最后手段。
- **选中正确的元素**:页面常有隐藏副本(如移动端按钮),用 `browser_execute` 过滤可见元素(`getBoundingClientRect()` 宽高 > 0、`getComputedStyle` 非 `display:none`),再取坐标。
- **取坐标后立即点击**:中间不要插入其他操作(填表、滚动会移动元素,旧坐标立即失效)。
- **点击前验证命中**:`document.elementFromPoint(x, y)` 确认该坐标确实是目标元素(按钮/链接),再执行真实点击。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

## 配置

插件通过 `cordis.patch.yml` 挂载三行,各行配置:

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 必填 | 宿主提供的 `ElectronBrowserViewHost` 实例(通常 `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;其余协议(如 `file:`/`data:`)拒绝(`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数,超出截断 |
| `browser-electron` | `contentMaxChars` | 数字 | `100000` | 内容抓取默认字符上限 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具(`browser_list_tabs` 等) |

## 工作原理

```
agent (browser_* 工具)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (由宿主外壳提供)
  → WebContentsView + webContents.debugger (CDP)
```

- **seam 层**(`browser` 行)提供 `ctx.browser` 服务:provider 注册、会话生命周期、错误码,与具体实现解耦;
- **provider 层**(`browser-electron` 行)通过 `ElectronBrowserViewHost` 接缝操作视图(创建/销毁/显示/`sendCommand`),由真实外壳用 Electron 对象实现;
- **工具层**(`tool-browser` 行)提供模型侧的 20 个 `browser_*` 工具,按调用方任务(DSH 会话)维护独立的浏览器会话。

**自托管模式**:没有桌面外壳时,插件自己拉起一个 Electron 子进程(`host-main.js`),通过本机 TCP JSON-RPC 驱动,窗口标题 `dsh-browser`。子进程崩溃会自动重启;截图优先走 Electron 原生 `capturePage`(CDP 截图在多视图下会挂起),并自动选择环境中**最新版本**的 Electron(33.x 有合成器缺陷,建议 ≥ 40)。

**Electron 定位顺序**:① `require('electron')`(peer 依赖)→ ② `ELECTRON_PATH`(显式覆盖)→ ③ DSH 安装锚点与 pnpm 虚拟仓库中**版本最新**者。找不到时工具会报清晰的错误提示。

## 与桌面外壳的分工

浏览器**可见视图**、**浏览器列布局**、**列与视图的对齐**都属于宿主外壳(如 dsh 的 `apps/desktop`),不在本插件内。本插件只消费外壳提供的 `electronViewHost`,负责 seam、provider 与工具。没有配套外壳时插件**自托管**,功能照常可用。

## 环境要求

- DeepSeek Harness(dsh)且安装了 `web` profile
- **Electron 运行时**(可选 peer 依赖):桌面外壳自带;纯 `dsh web` 下插件自动定位 Electron 二进制(见上,建议 ≥ 40)

### 验证过的版本

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness(dsh) | `0.1.0-rc.5` |
| Electron | `43.4.0`(推荐 ≥ 40;33.x 存在合成器缺陷) |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.11` |
| 操作系统 | Windows 10 (10.0.26200) |

> 插件声明 `electron >= 30`;其他平台(macOS/Linux)按同一协议运行,但仅在上表 Windows 环境实测。

## 已知限制

- 截图仅 PNG(CDP JPEG 在 Electron 43 上挂起);JPEG 等待非 CDP 转换路径。
- 自托管截图优先走 Electron 原生 `capturePage`(CDP `captureScreenshot` 在多视图下会挂起);截图前自动把目标标签置顶。
- 部分主机在软件合成下 `fullPage` 截图不稳定。
- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战,此时应请用户在共享窗口中人工完成,而不是反复重试。
- 无痕模式(`privateMode`)未实现:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- `browser_download` 在页面上下文内 `fetch`(带登录态),受同源/CORS 约束;单文件上限 256MB。
- `browser_auth` 的 cookie 往返不保留 `hostOnly`/`sameSite` 字段(host-only cookie 恢复后变成 domain cookie);仅自托管浏览器可用。
- 自托管浏览器子进程崩溃后会自动重启,但崩溃前已打开的会话视图已失效,调用 `browser_reset_session` 重建即可。
- 本插件不含浏览器列 UI——那是宿主外壳的配套,别把"浏览器列"当成插件能力。

## 开发

```sh
# 类型检查 + 构建(lib/)
pnpm run build

# 功能测试:启动本地页面服务器 + Electron probe(见仓库测试脚本)
```

代码结构:

| 目录 | 职责 |
| --- | --- |
| `src/browser/` | `ctx.browser` seam 与全部请求/结果类型 |
| `src/browser-electron/` | Electron CDP provider、自托管子进程(`host-main.ts`)与 RPC 层 |
| `src/tool-browser/` | 模型侧 `browser_*` 工具 |
| `src/types/` | electron 环境类型(shim,避免强制依赖 electron 类型) |

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队:本插件的 seam、工具运行时与插件体系都构建在这个项目之上。

同时感谢 [Cordis](https://github.com/cordiverse/cordis) 提供的插件化基础,以及所有参与讨论、测试、反馈和插件开发的社区成员。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是 DeepSeek Harness 的社区插件,并非 DeepSeek 官方产品。
