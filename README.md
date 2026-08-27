<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

<h3 align="center">为 DeepSeek Harness 生态打造的<b>共享真实浏览器</b>插件（装好即用，人机同页）</h3>

<h4 align="center">agent 驱动一个真实、可见、可随时人工接管的浏览器——人与 agent 操作的是<b>同一个页面</b>。</h4>

## 文档

| 目标 | 入口 |
| --- | --- |
| 了解插件为什么存在、与无头方案的区别 | [为什么做共享真实浏览器](docs/why-browser.md) |
| 安装、配置与日常使用 | [用户指南](docs/user-guide.md) |
| 全部 33 个工具的参数、输出与示例 | [工具参考](docs/tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](docs/architecture.md) |
| 查看全部文档与 README 分工 | [文档索引](docs/README.md) |

## 这是什么

`dsh-builtin-browser` 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供浏览器能力:

- **真实视图,而非转播**:浏览器是原生 `WebContentsView`,用户直接看到 agent 在做什么,随时可以上手接管;
- **装好即用**:有桌面外壳时嵌入外壳视图;纯 `dsh web` 也能**自托管**——插件自己拉起一个 Electron 窗口,不需要任何额外配置;
- **一插件即一套工具**:安装后 agent 自动获得 33 个 `browser_*` 工具(打开、查看、无障碍树、等待、语义/坐标操作、滚动、回退、批量/单控件填表、按键、结构化提取、截图、下载、登录态管理……)。

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
| `browser_wait` | 等待页面加载完成(可选期望 URL / CSS 选择器),返回是否就绪 | – |
| `browser_snapshot` | 交互元素(输入框/按钮/链接)带编号清单(穿透同源 iframe 与 Shadow DOM) | – |
| `browser_a11y` | 无障碍树:每个交互节点的语义角色/名称/值/状态 + 坐标(穿透同源 iframe 与 Shadow DOM) | – |
| `browser_execute` | 在页面执行 JS;参数以 `arguments[0..n]` 传入 | ✅ |
| `browser_content` | 以 html / markdown / txt / json 抓取页面(selector、maxChars、timeoutMs) | – |
| `browser_click` | 点击:语义目标(`target`: css/text/xpath,滚动到元素并点中心)或视口坐标(配合截图视觉定位) | ✅ |
| `browser_type` | 输入文本(可先按 `target` 聚焦元素;CDP `Input.insertText`) | ✅ |
| `browser_key` | 按命名按键(Enter/Tab/方向键/Home/End 等) | ✅ |
| `browser_scroll` | 滚动页面(像素增量 / 选择器定位 / 顶部底部) | ✅ |
| `browser_back` | 页面历史后退一步(无前项时为空操作) | ✅ |
| `browser_forward` | 页面历史前进一步(无后项时为空操作) | ✅ |
| `browser_refresh` | 刷新当前页(等价浏览器的刷新按钮) | ✅ |
| `browser_fill` | 批量填充表单(选择器/名称/标签匹配,受控输入、下拉、单选/复选,可选提交) | ✅ |
| `browser_set_value` | 单个控件设值(按 `target` 定位;原生 setter + input/change,React 受控输入可用) | ✅ |
| `browser_check` | 勾选/取消勾选 checkbox 或 radio(按 `target` 定位) | ✅ |
| `browser_select` | 选中 `<select>` 的某个选项(按值/文本/索引,按 `target` 定位) | ✅ |
| `browser_clear` | 清空输入/文本域/contenteditable,或取消勾选(按 `target` 定位) | ✅ |
| `browser_get_value` | 读取元素当前值(操作后验证用;按 `target` 定位) | – |
| `browser_scrape` | 结构化提取:容器选择器 + 字段映射(`选择器[@属性]`),静态 CSS 查询、CSP 安全 | – |
| `browser_screenshot` | 截图,可选 `fullPage`、`savePath`、JPEG(`format`/`quality`)与缩放(`maxWidth`/`maxHeight`) | – |
| `browser_list_tabs` | 当前会话的标签列表 | – |
| `browser_switch_tab` | 按 id 切换标签(自托管下同步切换可见视图) | ✅ |
| `browser_close_tab` | 按 id 关闭标签;关闭活动标签后激活下一个 | – |
| `browser_reset` | 关闭本任务所有标签,回到一个空白标签 | ✅ |
| `browser_session` | 查看本任务的浏览器会话与标签 | – |
| `browser_reset_session` | 关闭并重建本任务的浏览器会话 | ✅ |
| `browser_history` | 操作日志(最新在后),含成功/失败与结果摘要 | – |
| `browser_replay` | 按序号回放某一步(navigate/execute/click/type) | ✅ |
| `browser_download` | 带会话 cookie 下载 HTTP(S) URL 到本地文件(`savePath` 必须绝对路径,上限 256MB) | ✅ |
| `browser_auth` | 导出/恢复 cookie(登录态持久化,自托管可用) | ✅ |
| `browser_challenge` | 检测人机验证(CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile) | – |
| `browser_restrict` | 限制允许的浏览器动作(白名单;空列表解除)。**软护栏**,模型可自行解除,非安全边界 | – |

> 「守卫」列:打 ✅ 的动作受 `browser_restrict` 白名单约束;只读工具(snapshot/content/screenshot/list_tabs/session/challenge/history)永不拦截。

### 等待页面就绪

- **`browser_open` 之后、`browser_snapshot` 之前,慢站点请先 `browser_wait`**:传 `url`(你打开的地址)与可选的 `selector`,等它返回 `ready: true` 再拍照——否则拍到的是旧页面或白屏。
- 页面里看不到的内容先想 iframe / Shadow DOM:快照与无障碍树会穿透同源 iframe 与 shadow root 并标注 `(iframe)`,坐标始终是顶层文档坐标,可直接用 `browser_click`;DOM 选择器则是 frame 作用域的,需用 `browser_execute` 经 `iframe.contentDocument` 访问。

### 语义定位(`target`)与无障碍树

- **`browser_a11y` 是理解页面的首选**:它返回每个交互节点的语义角色(button/textbox/checkbox…)、可访问名称、当前值、状态(enabled/checked/expanded…)与坐标,比编号快照更能说明“这是什么、能做什么”;拿到坐标后可直接 `browser_click`/`browser_type`。
- **`browser_click`/`browser_type` 支持 `target` 定位**:`{by: css|text|xpath, value, index?}`——`text` 按元素自身可见文本匹配(精确优先、退化包含、最深元素优先);点击会把元素滚动到视口中央再点;输入会先聚焦该元素。
- **单控件操作用 `browser_set_value`/`browser_check`/`browser_select`/`browser_clear`/`browser_get_value`**,批量用 `browser_fill`,列表页结构化抓取用 `browser_scrape`。

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
| `browser-electron` | `downloadDir` | 字符串 | `~/Downloads` | 限定 `browser_download` 保存路径必须位于该目录内(防 agent 写任意路径);默认收敛到系统下载目录,可改为沙箱目录 |
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
- **工具层**(`tool-browser` 行)提供模型侧的 33 个 `browser_*` 工具,按调用方任务(DSH 会话)维护独立的浏览器会话。

**自托管模式**:没有桌面外壳时,插件自己拉起一个 Electron 子进程(`host-main.js`),通过本机 TCP JSON-RPC 驱动。RPC 带随机 token 认证,token 经 **stdin + 环境变量双通道**传递——Windows 上 Electron 是 GUI 子系统进程、收不到 piped stdin,环境变量兜底保证握手稳定。子进程崩溃会自动重启;优先使用随插件安装的 electron 包(**打包应用如 DSH Desktop.exe 不会被误当作可复用二进制**,避免 spawn 秒退);截图优先走 Electron 原生 `capturePage`(CDP 截图在多视图下会挂起),并自动选择环境中**最新版本**的 Electron(33.x 有合成器缺陷,建议 ≥ 40;44+ 首次使用自动下载二进制,需联网)。

**自托管浏览器就是一台真正的浏览器**:每个任务(DSH 会话)拥有**独立的浏览器窗口**,窗口自带完整工具栏——地址栏、后退/前进/刷新按钮、标签条(新建/切换/关闭标签)。人可以直接像用 Chrome 一样使用它:在地址栏输入网址(自动补 `https://`)、点标签切换页面、开新标签;键盘焦点跟随点击——**点地址栏即可输入、点页面即可操作**(Windows 焦点路由,修复了点击不转移焦点导致地址栏无法输入的问题)。agent 与人的操作都汇入**同一个会话模型**(同一套标签、历史与导航),窗口标题实时显示当前任务标识与页面标题/URL,窗口缩放时视图自动跟随。任务结束后窗口随会话自动关闭。

**Electron 定位顺序**:① `ELECTRON_PATH`(显式覆盖,用户显式意图最优先)→ ② 随插件安装的 electron 包(纯文件系统探测,不触发 44+ 懒下载;覆盖 node_modules 与 pnpm store 两种布局)→ ③ DSH 安装锚点与 pnpm 虚拟仓库中**版本最新**者 → ④ 当前进程为**裸** Electron 时复用宿主二进制(开发模式)→ ⑤ 进程祖先树中的**裸** Electron 宿主(Windows 走 PowerShell CIM,仅最后手段)。**打包应用(如 `DSH Desktop.exe`)一律不复用**——它们不能按脚本参数拉起,误用会导致 spawn 秒退(issue #6);找不到时工具会报清晰的错误提示(含 `npx install-electron` 指引)。

## 与桌面外壳的分工

浏览器**可见视图**、**浏览器列布局**、**列与视图的对齐**都属于宿主外壳(如 dsh 的 `apps/desktop`),不在本插件内。本插件只消费外壳提供的 `electronViewHost`,负责 seam、provider 与工具。没有配套外壳时插件**自托管**,功能照常可用。

## 环境要求

- DeepSeek Harness(dsh),已安装对应 profile(`web` / `desktop` 等)
- **Electron 运行时**(必装依赖,随插件自动安装,建议 ≥ 40;44+ 首次使用自动下载二进制,需网络):
  - `ELECTRON_PATH` 可显式指定其他二进制(最优先);
  - **DSH Desktop**:打包宿主 exe(`DSH Desktop.exe`)**不复用**——打包应用无法按脚本参数拉起,误用会秒退(issue #6);直接使用随包 electron,开发模式的**裸** Electron 宿主仍可复用;
  - **纯 `dsh web` 自托管**:直接使用随插件安装的 electron 包

### 验证过的版本

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness(dsh) | `0.1.1-rc.2`(peer 声明 `^0.1.1-rc.2`) |
| Electron | `44.0.0`(推荐 ≥ 40;33.x 存在合成器缺陷) |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.20` |
| 操作系统 | Windows 10 (10.0.26200) |

> 插件声明 `electron >= 30`;**当前仅在 Windows 环境实测**(macOS/Linux 未验证,暂不承诺)。

## 已知限制

- JPEG 截图仅自托管原生路径可用(`capturePage` 的 `toJPEG`);桌面壳的 CDP 回退路径仍为 PNG(CDP JPEG 在 Electron 43 上挂起)。
- 自托管截图优先走 Electron 原生 `capturePage`(CDP `captureScreenshot` 在多视图下会挂起);截图前自动把目标标签置顶。
- 部分主机在软件合成下 `fullPage` 截图不稳定。
- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战,此时应请用户在共享窗口中人工完成,而不是反复重试。
- 无痕模式(`privateMode`)未实现:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- `browser_download` 在页面上下文内 `fetch`(带登录态),受同源/CORS 约束;仅允许 HTTP(S) 目标;`savePath` 必须为绝对路径(默认限定在 `~/Downloads`,可用 `downloadDir` 覆盖);单文件上限 256MB(流式限流,按 Content-Length 提前拒绝),文件由浏览器子进程直接落盘(临时文件 + 原子改名)。
- 自托管浏览器的 cookie 在磁盘上以明文存储(Electron 默认行为);需要加密落盘的部署应在宿主层接入系统钥匙串 / DPAPI。
- `browser_restrict` 是防误操作的**软护栏**,不是安全边界:模型可以自行解除白名单。
- 页面弹窗(`window.open` / `target=_blank`)会被重定向到当前标签页内打开,不创建独立窗口,以免破坏标签/会话模型。
- `browser_auth` 的 cookie 往返不保留 `hostOnly`/`sameSite` 字段(host-only cookie 恢复后变成 domain cookie);仅自托管浏览器可用。
- 自托管浏览器子进程崩溃(或宿主 DSH 重启)后会自动重启;崩溃前已打开的会话在**下一次调用时自动重建**——仅页面状态丢失,无需手动 `browser_reset_session`。`browser_reset_session` 仍可用于主动重置。
- electron 随插件安装;Electron 44+ 首次打开浏览器窗口时自动下载二进制(约 100MB,需网络),之后不再需要。若探测时网络不可用,可预装 `ELECTRON_PATH` 指定的二进制。
- 本插件不含浏览器列 UI——那是宿主外壳的配套,别把"浏览器列"当成插件能力。

## 开发

```sh
# 类型检查 + 构建(lib/)
npm run build
```

> 运行测试: `npm test`(= `tsc -p tsconfig.json` + `node --test "tests/*.test.mjs"`,假 host 测试,无需 Electron)。

代码结构:

| 目录 | 职责 |
| --- | --- |
| `src/browser/` | `ctx.browser` seam 与全部请求/结果类型 |
| `src/browser-electron/` | Electron CDP provider、自托管子进程(`host-main.ts`)与 RPC 层 |
| `src/tool-browser/` | 模型侧 `browser_*` 工具 |
| `src/types/` | electron 环境类型(shim,避免强制依赖 electron 类型) |

## 更新记录

> 按轮次记录的开发与修复历程(完整明细见 [CHANGELOG.md](CHANGELOG.md))。**0.1.16** 起随版本发布(tag `v0.1.16`)。

| 轮次 | 日期 | 内容 |
| --- | --- | --- |
| 第一轮 | 2026-08-18 | **安全与健壮性修复**:RPC 随机 token 认证 + 单连接强制;下载准入(仅 HTTP(S)、绝对路径、`downloadDir` 限定)与流式限流(Content-Length 提前拒绝,256MB 上限);CDP 超时打断与 click/type 超时松键恢复;会话/白名单改为每任务作用域并随 agent 生命周期自动关闭;操作历史脱敏(输入文本、replay/execute 参数不泄露);弹窗重定向回标签页 |
| 第二轮 | 2026-08 | **功能补全 + 测试 + CI**:窗口标题显示任务标识、showView 无闪烁;快照/无障碍树穿透同源 iframe 与 Shadow DOM;新增 `browser_wait`/`scroll`/`back`/`forward`/`key` 工具;真实 `available()` 探测;下载改由子进程直接落盘(临时文件 + 原子改名);Electron 定位收敛;JPEG/缩放截图;快照性能优化;新增测试套件与 CI |
| 第三轮 | 2026-08 | **对标 browser-bridge 的功能 + 审查修复**:`browser_a11y` 无障碍树;表单控件 6 件套(`browser_set_value`/`check`/`select`/`clear`/`get_value`/`refresh`);语义定位 `target`(css/text/xpath);`browser_scrape` 结构化提取;独立 BrowserWindow + 真实工具栏(地址栏/后退/前进/刷新/标签条),工具栏操作路由回会话模型;工具总数 **20 → 33**;CI 改 npm(无 lockfile 不兼容 pnpm cache)、README 修正等审查项 |
| 第四轮 | 2026-08 | **DSH 0.1.1-rc.2 对齐 + 复查修复**:peer 下限对齐 `^0.1.1-rc.2`;修复 `browser_type` 带 target 丢文本、`browser_key` 空格缺 CDP `text`、keyUp 失败卡键、`browser_wait` URL 同源误匹配、download `.part` rename 残留、`snapshotMaxElements`/`contentMaxChars` 配置接线、导出类型补齐;新增 3 个回归测试 |
| 第五轮 | 2026-08 | **Electron 44 兼容**:`available()` 改为无副作用探测(不再触发 Electron 44 懒下载);`flushAuth` cookie-domain 构建错误修复 |
| 第六轮 | 2026-08 | **Windows 握手与标签定位**:Electron GUI 进程收不到 piped stdin → RPC token 改 **stdin + 环境变量双通道**;`browser_switch_tab`/`browser_close_tab` 跨会话按 id 定位(`locateTab`),`browser_close_tab` 不再静默假成功,未知 id 报错附带现有标签列表 |
| 第七轮 | 2026-08 | **工具栏交互(Windows 焦点路由)**:键盘输入只进有焦点的 view,页面 view 抢占焦点导致地址栏无法输入 → 新增 `wireFocusRouting`(点击即聚焦该 view)+ 窗口 refocus 恢复上次点击的 view;真机 OS 输入探针验证 |
| **0.1.16** | 2026-08-26 | **发布**:以上七轮全部随 **0.1.16** 发布(构建零错误、21 项测试全绿,`v0.1.16`) |
| 第八轮 | 2026-08-27 | **DSH Desktop 宿主 Electron 复用**:插件运行在 Electron 进程内直接复用宿主二进制;插件跑在宿主子 Node 进程时沿进程祖先树找到宿主 Electron 兜底(Windows 用 PowerShell CIM,仅最后手段)——DSH Desktop **零安装开箱可用**;报错按当前 profile 动态提示;补齐 electron shim 修复 CI 类型检查;文档同步 |
| **0.1.17** | 2026-08-27 | **发布**:第八轮修复随 **0.1.17** 发布(构建零错误、21 项测试全绿) |
| 第九轮 | 2026-08-27 | **electron 改为必装依赖**:从 optional peer 移入 `dependencies`,安装插件即自动带上 electron 包(44+ 二进制首次使用懒下载);DSH Desktop 依旧复用宿主二进制;文档与报错同步 |
| **0.1.18** | 2026-08-27 | **发布**:第九轮「electron 改为必装依赖」随 **0.1.18** 发布(构建零错误、21 项测试全绿) |
| 第十轮 | 2026-08-27 | **DSH-Store 兼容性声明**:新增 `dsh.compatibility.dshReleases`(rc.2/rc.1=compatible、rc.8=unknown)与 profiles/dsh 范围,解除商店自动下架(HOLD) |
| **0.1.19** | 2026-08-27 | **发布**:第十轮「DSH-Store 兼容性声明」随 **0.1.19** 发布(构建零错误、21 项测试全绿) |
| 第十一轮 | 2026-08-27 | **自托管宿主崩溃后的会话自愈**(issue #5):宿主死亡(DSH 重启 / checkpoint 恢复 / 崩溃)后,已打开的会话在**下一次调用时自动重建宿主并重试**——不再报 "browser host is not running",半死态消除;新增 host-gone 日志与假子进程回归测试 |
| 第十二轮 | 2026-08-27 | **resolveElectronPath 排除打包应用**(issue #6):新增 `isBareElectron`(旁有 `app.asar` 即打包应用,一律不复用,全平台含 macOS bundle 布局);bundled electron 纯文件系统探测置最优先;`ELECTRON_PATH` 显式覆盖最优先;dist 缺失时明确报错(`npx install-electron` 指引) |
| 全面复审加固 | 2026-08-27 | **三轮审查加固**:并发恢复双重建竞态(child `createView` 幂等化)、macOS bundle 路径判定、`dispose()` vs `start()` 僵尸 child 竞态三道闸、pendingSocket 泄漏、选路顺序全量单测(24→25 项测试) |
| **0.1.20** | 2026-08-27 | **发布**:第十一/十二轮 + 全面复审加固随 **0.1.20** 发布(构建零错误、25 项测试全绿) |

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队:本插件的 seam、工具运行时与插件体系都构建在这个项目之上。

同时感谢 [Cordis](https://github.com/cordiverse/cordis) 提供的插件化基础,以及所有参与讨论、测试、反馈和插件开发的社区成员。

## 作者的话

对插件本身有意见或者有想要制作的其他插件,欢迎加我微信来讨论:

**wx:`hui13866591135`**(请在申请好友时注明)

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是 DeepSeek Harness 的社区插件,并非 DeepSeek 官方产品。
