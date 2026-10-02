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
| 全部 34 个工具的参数、输出与示例 | [工具参考](docs/tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](docs/architecture.md) |
| 查看全部文档与 README 分工 | [文档索引](docs/README.md) |

## 这是什么

`dsh-builtin-browser` 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供浏览器能力:

- **真实页面,而非转播**:页面由**真实的浏览器**承载 —— 桌面端就是官方侧栏里那一个,Web 端是插件拉起的窗口,也可以在设置里改用**你本机的 Chrome / Edge**。用户直接看到 agent 在做什么,随时可以上手接管;
- **人机同页**(桌面端):agent 操作的页面与人看到的是**同一个**页面 —— 不再是一个你看不见的窗口;
- **装好即用**:载体自动选择(桌面端侧重侧栏 → 否则自托管),纯 `dsh web` 不需要任何额外配置;
- **一插件即一套工具**:安装后 agent 自动获得 34 个 `browser_*` 工具(打开、查看、无障碍树、等待、语义/坐标操作、滚动、回退、批量/单控件填表、按键、结构化提取、截图、下载、登录态管理……)。

一句话:**安装插件 = 获得一个与用户共享、可被 agent 驱动的真实浏览器。**

## 快速开始

插件要装进**你要用的那一端**的 profile 里。两端都装也可以,一份代码两个 profile 各一份。

**Web 端(纯 `dsh web`)**

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-builtin-browser
# 或从源码目录安装(独立仓库,一插件一仓库)
dsh plugin --profile web add <本仓库路径>
```

**桌面端(DSH Desktop)**

```sh
# 1. 装进桌面端 profile
dsh plugin --profile desktop add dsh-builtin-browser

# 2. 桌面端特有的一步:让插件能驱动官方侧栏的页面
node <本仓库路径>/desktop-bridge/install.mjs
```

> **第 2 步不是可选项,而且每次都要重来一次**:桌面端升级会替换 `resources/app/`,bridge 也随之消失;插件更新后同样需要重装。bridge 不在时插件自动退回"自己开一个独立窗口",功能不中断,只是失去"人机同页"。Web 端**没有**这一步。

**更新**(两端方式不同,详见[更新方式](#更新方式两端不同))

| 端 | 更新步骤 |
| --- | --- |
| Web 端 | 更新 profile 里的依赖 → 重启 `dsh web` |
| 桌面端 | 更新依赖 → **重跑 `node desktop-bridge/install.mjs`** → 重启 DSH Desktop |

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
      <p><code>browser_snapshot</code> 返回带编号的交互元素;<code>browser_execute</code> 在页面内执行 JS(受控输入用原生 setter + input/change 事件),React/Vue 页面也能可靠交互。<b>语义定位优先</b> —— 不需要图像输入即可完整操作;设置成<b>纯非视觉</b>策略后,依赖截图的坐标点击会被明确拒绝并提示改用语义定位。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>多标签会话</h3>
      <p>并行打开 URL,查看/切换/关闭/重置标签,每个会话的状态独立保持。桌面端下<b>每个会话独占侧栏里自己的一个标签页</b>,结束一个会话不会影响另一个。</p>
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
  <tr>
    <td width="50%" valign="top">
      <h3>可查的浏览历史</h3>
      <p><code>browser_visited</code> 读取<b>持久化</b>的访问记录(与 cookie 同址落盘,关闭浏览器、重启 DSH 后仍在),可按域名过滤并重新打开任意一条。它与 <code>browser_history</code>(会话内的操作日志)是两件事。</p>
    </td>
    <td width="50%" valign="top">
      <h3>可视化鼠标</h3>
      <p>agent 操作时在页面内绘制虚拟光标、点击涟漪,并在指针旁用<b>气泡标注当前动作</b> —— <b>光标出现即表示它已接管该标签页</b>;DOM 级操作(填值/勾选/选择)同样有落点。不动真实系统鼠标,可在设置里关闭。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>设置页里的「浏览器」栏</h3>
      <p><b>用哪个浏览器</b>(内置 Electron / 本机 Chrome / 本机 Edge / 自动)、历史与 cookie 是否保留、侧栏是否自动展开、会话结束时是否关闭浏览器、是否显示光标、视觉策略、是否允许读取凭据 —— 开关<b>即时生效</b>,无需重启。</p>
    </td>
    <td width="50%" valign="top">
      <h3>收尾明确</h3>
      <p><b>关掉承载页面 = 结束该会话</b>(下次打开是干净的新会话)—— 桌面端是关掉侧栏里那个浏览器标签,Web 端是关掉窗口;浏览历史与登录状态<b>不受影响</b>。<b>收起界面只是收起</b>,浏览器继续运行。会话结束时是否自动释放,由设置项决定。</p>
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
| `browser_visited` | 读取持久化浏览历史(访问过的页面,可按域名过滤/限量);重开用 `browser_open` | – |
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
| `browser_screenshot` | 截图,可选 `fullPage`、`savePath`、JPEG(`format`/`quality`)与缩放(`maxWidth`/`maxHeight`);`savePath` 与下载同一准入门(限定在 `downloadDir` 内、不覆盖已有文件) | – |
| `browser_list_tabs` | 当前会话的标签列表 | – |
| `browser_switch_tab` | 按 id 切换标签(自托管下同步切换可见视图) | ✅ |
| `browser_close_tab` | 按 id 关闭标签;关闭活动标签后激活下一个 | – |
| `browser_reset` | 关闭本任务所有标签,回到一个空白标签 | ✅ |
| `browser_session` | 查看本任务的浏览器会话与标签 | – |
| `browser_reset_session` | 关闭并重建本任务的浏览器会话 | ✅ |
| `browser_history` | 操作日志(最新在后),含成功/失败与结果摘要 | – |
| `browser_replay` | 按序号回放某一步(navigate/execute/click/type) | ✅ |
| `browser_download` | 带会话 cookie 下载 HTTP(S) URL 到本地文件(`savePath` 必须绝对路径且位于 `downloadDir` 内,不覆盖已有文件,上限 256MB) | ✅ |
| `browser_auth` | 导出/恢复 cookie(登录态持久化,自托管可用) | ✅ |
| `browser_challenge` | 检测人机验证(CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile) | – |
| `browser_restrict` | 限制允许的浏览器动作(白名单;空列表解除)。**软护栏**,模型可自行解除,非安全边界 | – |

> 「守卫」列:打 ✅ 的动作受 `browser_restrict` 白名单约束;只读工具(snapshot/content/screenshot/list_tabs/session/challenge/history)永不拦截。

### 等待页面就绪

- **`browser_open`/导航已有界等待新文档解析完成**(`readyState` + 文档指纹,不把同 URL 重载或 A→B→A 重定向误判成旧文档),但仍**不等异步内容**:慢站点或依赖 XHR 渲染的页面,请在 `browser_snapshot` 之前先 `browser_wait`——传 `url`(你打开的地址)与可选的 `selector`,等它返回 `ready: true` 再拍照,否则拍到的是旧页面或白屏/空元素列表。
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

插件通过 `cordis.patch.yml` 挂载**四行**:一个**惰性的根行**(只用来声明包名,宿主的客户端插件扫描靠它读到 `dsh.client`,否则设置栏不会出现)+ 三个功能行(`browser` / `browser-electron` / `tool-browser`)。各行配置:

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 可选 | 宿主提供的 `ElectronBrowserViewHost` 实例(如 `!!js ctx.get('electronViewHost')`)。**不传时插件自己选载体** —— 桌面端驱动官方侧栏、否则自托管;若在设置里指定了本机 Chrome / Edge,该选择优先于两者 |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;其余协议(如 `file:`/`data:`)拒绝(`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数,超出截断 |
| `browser-electron` | `contentMaxChars` | 数字 | `100000` | 内容抓取默认字符上限 |
| `browser-electron` | `downloadDir` | 字符串 | 系统下载目录(自动识别 `Downloads`/`下载`/`下載`,或 `XDG_DOWNLOAD_DIR`) | 限定 `browser_download` 与 `browser_screenshot` 的保存路径必须位于该目录内,且不覆盖已有文件(防 agent 写任意路径或替换现有文件);默认收敛到系统下载目录,可改为沙箱目录 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具(`browser_list_tabs` 等) |

## 工作原理

```
agent (browser_* 工具)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost  ← 同一个接缝,三种载体各实现一份
      ① 桌面端侧栏      经 bridge → 外壳主进程 → webContents.debugger (CDP)
      ② 本机 Chrome/Edge 经 WebSocket → CDP
      ③ 自托管 Electron  经本机 TCP JSON-RPC → 子进程 → CDP
```

- **seam 层**(`browser` 行)提供 `ctx.browser` 服务:provider 注册、会话生命周期、错误码,与具体实现解耦;
- **provider 层**(`browser-electron` 行)只认 `ElectronBrowserViewHost` 这一个接缝(创建/销毁/显示/`sendCommand`),因此**换载体不需要动工具、历史、光标与收尾逻辑**;
- **工具层**(`tool-browser` 行)提供模型侧的 34 个 `browser_*` 工具,按调用方任务(DSH 会话)维护独立的浏览器会话。

**自托管模式**:没有桌面外壳时,插件自己拉起一个 Electron 子进程(`host-main.js`),通过本机 TCP JSON-RPC 驱动。RPC 带随机 token 认证,token 经 **stdin + 环境变量双通道**传递——Windows 上 Electron 是 GUI 子系统进程、收不到 piped stdin,环境变量兜底保证握手稳定。子进程崩溃会自动重启;优先使用随插件安装的 electron 包(**打包应用如 DSH Desktop.exe 不会被误当作可复用二进制**,避免 spawn 秒退);截图优先走 Electron 原生 `capturePage`(CDP 截图在多视图下会挂起);Electron 的定位顺序见下(33.x 有合成器缺陷,建议 ≥ 40;44+ 的 electron 包不再随安装自动下载二进制,首次使用若缺失会按报错提示先 `npx install-electron`,需联网)。

**自托管浏览器就是一台真正的浏览器**(Web 端、或没有桌面外壳时的形态):每个任务(DSH 会话)拥有**独立的浏览器窗口**,窗口自带完整工具栏——地址栏、后退/前进/刷新按钮、标签条(新建/切换/关闭标签)。人可以直接像用 Chrome 一样使用它:在地址栏输入网址(自动补 `https://`)、点标签切换页面、开新标签;键盘焦点跟随点击——**点地址栏即可输入、点页面即可操作**(Windows 焦点路由,修复了点击不转移焦点导致地址栏无法输入的问题)。agent 与人的操作都汇入**同一个会话模型**(同一套标签、历史与导航),窗口标题实时显示当前任务标识与页面标题/URL,窗口缩放时视图自动跟随。任务结束后窗口随会话自动关闭。

**Electron 定位顺序**:① `ELECTRON_PATH`(显式覆盖,用户显式意图最优先)→ ② 随插件安装的 electron 包(纯文件系统探测,不触发 44+ 懒下载;覆盖 node_modules 与 pnpm store 两种布局)→ ③ DSH 安装锚点与 pnpm 虚拟仓库中**版本最新**者 → ④ 当前进程为**裸** Electron 时复用宿主二进制(开发模式)→ ⑤ 进程祖先树中的**裸** Electron 宿主(Windows 走 PowerShell CIM,仅最后手段)。**打包应用(如 `DSH Desktop.exe`)一律不复用**——它们不能按脚本参数拉起,误用会导致 spawn 秒退(issue #6);找不到时工具会报清晰的错误提示(含 `npx install-electron` 指引)。

## 与桌面外壳的分工

插件会自动选载体,也可以在设置里指定(共四种,见下):

**① 桌面端:驱动官方侧栏的页面(人机同页)**

DSH Desktop 是两层结构:Electron 外壳 + 一个 `--expose-internals` 的 **Node 模式宿主**(插件就跑在宿主里,**没有 Electron API**)。0.2 移除了 `electronViewHost`,宿主与外壳之间也没有任何承载视图的通道,所以插件**借道一条小桥**:外壳主进程里跑一个 loopback + token 的 bridge,把侧栏浏览器的 guest(就是你在界面上看到的那个页面)的 CDP 交给插件。

结果是:**agent 操作的页面就是人看的页面**,插件不再 spawn 自己的 Electron,也不再出现第二个窗口。

安装这条桥(改的是**已安装的桌面端**,所以做成可重放):

```bash
node desktop-bridge/install.mjs            # 幂等;首次会备份 main.js.before-bridge
node desktop-bridge/install.mjs --revert   # 回滚
```

> **桌面端升级后要重跑一次 `install.mjs`** —— 升级会替换 `resources/app/`,bridge 随之消失。bridge 不在时插件自动退回自托管,功能不会中断,只是会多出一个独立窗口。

> **⚠️ 沙箱边界的变化(请明示知悉)**
>
> 官方侧栏浏览器的前提是:侧栏里的页面**不被外部读取** —— 它有独立的 partition,且宿主拒绝跨站内容访问。让 Agent 驱动该 guest,等于**有意打破这个前提**:
>
> - Agent 能读到你在侧栏访问的**任何页面的内容**(这正是"人机同页"的意义);
> - Agent 能读到该 partition 中的 **Cookie / 登录态**,`browser_auth` 可将其导出(由设置项控制);
> - 反过来,你在侧栏里的操作与 Agent 的操作**作用于同一个页面**,可能互相影响(Agent 不会主动覆盖你的输入,但导航会改变双方看到的内容)。
>
> 这是"人机同页"的必然代价。我们认为值得(它把"Agent 在一个你看不见的窗口里操作"变成"你能看着它操作并随时接手"),但你有权知道它存在 —— 因此也提供了开关:**「凭据访问」关闭后 Agent 不再读取 Cookie/登录态**;**「视觉策略」设为纯非视觉后,任何依赖截图定位的坐标点击都会被拒绝**。不想接受这个边界变化时,把 desktop profile 里的插件移除即可回到"独立窗口"的旧形态。

**② 用你自己的浏览器(Chrome / Edge)**

设置里可以把载体改成**本机已安装的 Chrome 或 Edge**(`browser.channel`:`bundled` / `auto` / `chrome` / `edge`)。做法与 Codex Browser Use 一致:以 `--remote-debugging-port=0` 启动,读浏览器自己写下的 `DevToolsActivePort` 得到端口,再全程走 CDP(用 Node 22 内置的 `WebSocket`,**不新增依赖**)。

**你自己的数据不会被碰**:插件用的是**独立 profile**(`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`),不会打开、占用或修改你日常的窗口、书签与登录状态;插件退出也不会关掉你的浏览器。

**登录态怎么办**:

- `cookies.persist` **开**(默认)→ 上面那个固定 profile 会保留,**重启 DSH 后仍是登录状态**;`browser_auth` 也照常可导出/恢复该 profile 的 Cookie。
- `cookies.persist` **关** → 每次用**临时 profile**,释放浏览器时整个目录被删除,不留登录痕迹。
- 代价要说清:独立 profile **看不到**你日常浏览器里已登录的站点 —— 在插件打开的窗口里登录一次即可,之后登录态就存在它自己的 profile 里。

**③ 有 `electronViewHost` 的宿主(旧版桌面外壳)**:直接使用外壳提供的视图。

**④ 没有外壳(纯 `dsh web`)**:自托管 —— spawn 插件自带的 Electron 窗口,功能照常。

> 可见视图与列布局始终属于宿主外壳;插件只负责 seam、provider 与工具。各形态下**工具集、浏览历史、设置栏、可视化鼠标、收尾语义完全一致**,差别只在页面由谁承载。
>
> **优先级**:设置里显式选择的本机浏览器 > 桌面端侧栏 > 自托管。选定的浏览器**没装或起不来**时会记一条警告并继续用内置浏览器 —— **不会静默换成别的**。

## 环境要求

- DeepSeek Harness(dsh),已安装对应 profile(`web` / `desktop` 等)
- **Electron 运行时**(随插件自动安装,建议 ≥ 40;44+ 的二进制不随安装自动下载,缺失时按报错提示先 `npx install-electron`,需网络)—— **只有自托管载体需要它**:
  - `ELECTRON_PATH` 可显式指定其他二进制(最优先);
  - **桌面端:默认走官方侧栏,不需要 Electron**;退回自托管时使用随包 electron。打包宿主 exe(`DSH Desktop.exe`)**不复用** —— 打包应用无法按脚本参数拉起,误用会秒退(issue #6);开发模式的**裸** Electron 宿主仍可复用;
  - **改用本机 Chrome / Edge 时也不需要 Electron**;
  - **纯 `dsh web` 自托管**:直接使用随插件安装的 electron 包

### 验证过的版本

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness(dsh) | `0.2.0-rc.2`(peer 声明 `>=0.1.1-rc.2 <0.3.0`) |
| Electron | `44.0.0`(推荐 ≥ 40;33.x 存在合成器缺陷) |
| Node.js | `22.20.0` |
| 本机 Chrome / Edge(可选载体) | `154.0.8037.58` / `154.0.4258.37` |
| dsh-builtin-browser | `0.3.1` |
| 操作系统 | Windows 10 (10.0.26200) |

> 插件声明 `electron >= 30`。**核心链路在 Windows 上完整实测**;系统浏览器的查找已适配 Linux 与 macOS(先查 `PATH`,再查各平台的惯例安装位置,均可用 `DSH_BROWSER_CHROME_PATH` / `DSH_BROWSER_EDGE_PATH` 覆盖),但这两个平台上的**端到端链路尚未实测**,暂不承诺。

## 更新方式(两端不同)

插件在两种宿主里各有一份安装,更新路径也不同 —— **更新其中一端不会连带更新另一端**。

**桌面端(DSH Desktop)**
- 插件是桌面端 profile 里的依赖(profile 目录通常是 `$DSH_HOME/profiles/desktop`)。更新它 = 把该 profile 里的依赖更新到新版本,然后**重启 DSH Desktop**,客户端设置栏与工具才会换成新代码。
- **桌面端还多一步,而 Web 端没有**:让插件驱动侧栏的那条 bridge 装在**桌面端自己的安装目录**里(`resources/app/`),插件更新**不会**带上它。桌面端升级会替换该目录、bridge 随之消失,所以请重跑一次:
  ```bash
  node desktop-bridge/install.mjs            # 幂等;已装则只刷新模块
  node desktop-bridge/install.mjs --revert   # 回滚
  ```
  bridge 不在时插件自动退回自托管(多出一个独立窗口),功能不中断。
- 浏览器内核默认由桌面端自带的 Electron 提供,插件不会再下载一份 Electron;也可以在设置里改用它自己装的 Chrome / Edge。
- **选了某个浏览器但它没装时会怎样**:`内置` 用自己的 Electron;`自动` 挑一个已装的、**都没有就安静地退回内置**;**明确选了 Chrome / Edge** 而它不在时则**直接报错说明找不到它**(报错里写明查了哪些名字与位置,并给出三条出路:装上它 / 用 `DSH_BROWSER_CHROME_PATH`、`DSH_BROWSER_EDGE_PATH` 指定路径 / 把载体改回 `内置` 或 `自动`)—— 不会让你对着一条关于 Electron 的错误去猜真正的原因。

**Web 端(`dsh web`)**
- 插件是 web profile 里的依赖(`$DSH_HOME/profiles/web`),更新后**重启 `dsh web`** 生效。
- Web 端**没有侧栏、也没有 bridge**:共享浏览器由插件自托管拉起。首次安装可能需要 Electron 二进制;若包管理器的构建白名单拦下了它(pnpm v10+ 会拦 `electron` 的 postinstall),执行一次 `npx install-electron` 补上即可。
- 同样可以在设置里改用本机 Chrome / Edge —— 这是两端**行为一致**的选项。
- 更新方式与你首次安装它时一致(按 npm 包名 `dsh-builtin-browser`、按 GitHub 仓库 `wqty123/dsh-browser`,或本地目录)。

**两端一致的体验**
- 工具集(34 个 `browser_*`)、设置页里的「浏览器」栏、浏览历史与 cookie 的持久化行为完全相同;差别只在页面由谁承载(桌面端=官方侧栏,Web 端=插件自托管窗口,或你在设置里指定的本机浏览器)。
- 升级不会丢数据:浏览历史与设置都在 `$DSH_HOME/dsh-builtin-browser-host/`(`history.jsonl`、`settings.json`),登录状态在同一 profile 目录里 —— 包括使用本机浏览器时的 `<chrome|edge>-profile`。
- 升级后如果历史记录不符合预期,先去「设置 → 浏览器」确认这些开关:历史默认**开**、侧栏自动展开默认**开**、会话结束时自动关闭浏览器默认**关**、载体默认**内置**。

## 已知限制

- JPEG 截图在**自托管**与**本机 Chrome / Edge** 上可用;**桌面端侧栏**走外壳的 `webContents.debugger`,其 Electron 的 CDP JPEG 编码会挂起,因此该载体下请求 JPEG 会返回 PNG。降采样(`maxWidth`/`maxHeight`)**三种载体都支持**(经 CDP `clip.scale`,或用自托管的原生 `capturePage`)。
- 自托管截图优先走 Electron 原生 `capturePage`(CDP `captureScreenshot` 在多视图下会挂起);截图前自动把目标标签置顶。
- `fullPage` 截图在部分主机的**软件合成**下不稳定 —— 这只影响**自托管**载体(它走 `capturePage`);侧栏与本机浏览器走 CDP 的 `captureBeyondViewport`,不受此影响。
- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战,此时应请用户在共享窗口中人工完成,而不是反复重试。
- 无痕模式(`privateMode`)未实现:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- `browser_download` 在页面上下文内 `fetch`(带登录态),受同源/CORS 约束;仅允许 HTTP(S) 目标;`savePath` 必须为绝对路径且位于 `downloadDir` 内(默认系统下载目录,自动识别 `Downloads`/`下载`/`下載` 与 `XDG_DOWNLOAD_DIR`,可用 `downloadDir` 覆盖),不覆盖已存在文件;`browser_screenshot` 的 `savePath` 走同一准入门;单文件上限 256MB(流式限流,按 Content-Length 提前拒绝),文件由浏览器子进程直接落盘(临时文件 + 原子改名)。
- 自托管浏览器的 cookie 在磁盘上以明文存储(Electron 默认行为);需要加密落盘的部署应在宿主层接入系统钥匙串 / DPAPI。
- `browser_restrict` 是防误操作的**软护栏**,不是安全边界:模型可以自行解除白名单。
- 页面弹窗(`window.open` / `target=_blank`)不再覆盖当前视图:HTTP(S) 弹窗会在同一会话窗口**新开一个标签页**并计入历史,原页面与 opener 上下文保留;非 HTTP(S) 弹窗(空 URL 弹窗承接、`mailto:`、自定义协议)仍**放行原生窗口**,交给系统处理——这类弹窗不纳入会话模型。
- `browser_auth` 的 cookie 往返不保留 `hostOnly`/`sameSite` 字段(host-only cookie 恢复后变成 domain cookie)。**三种载体都可用**:自托管走原生会话,侧栏与本机浏览器走 CDP 的 `Storage.getCookies` / `Storage.setCookies`。
- 自托管浏览器子进程崩溃(或宿主 DSH 重启)后会自动重启;崩溃前已打开的会话在**下一次调用时自动重建**——仅页面状态丢失,无需手动 `browser_reset_session`。`browser_reset_session` 仍可用于主动重置。新视图创建前会先有界加载 `about:blank`(保证视图一存在就有可响应的渲染进程),宿主侧命令另有 20s 有界超时;子进程 stderr 与退出码/信号落到 `$DSH_HOME/logs/dsh-builtin-browser-host.log`,超过 2 MiB 时**轮转并保留一行时间戳标记**(不再整体清空 —— 那样会把几周的历史一起抹掉),纯 `dsh web` 自托管可据此自助排查崩溃循环。
- electron 随插件安装;但 Electron 44+ 不再随安装下载二进制(约 100MB,需网络)——插件探测是纯文件系统、不触发其懒下载,二进制缺失时首次使用会报错并提示先 `npx install-electron`;也可预装 `ELECTRON_PATH` 指定的二进制。
- 本插件不提供任何**浏览器界面**(地址栏、标签条、侧栏面板都不是插件画的):桌面端的浏览器界面是**外壳自带的官方侧栏**,我们只是借它的页面来驱动;自托管载体下画窗口的是插件拉起的那个 Electron 子进程,那是载体本身而非插件 UI。别把"侧栏"或"浏览器列"当成插件能力。
- **侧栏载体不上报"用户操作"事件**:人在那个页面里点击是外壳自己的事件,而 bridge 没有用于回报它的操作。因此依赖该事件的功能(如自定义的接管提示)在桌面端侧栏下不会触发;换到自托管载体则可以。
- **本机 Chrome / Edge 载体使用插件自己的 profile**:插件用它自己的用户数据目录启动浏览器(`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`),所以你日常浏览器里的书签、扩展与登录态**不会自动继承** —— 这是刻意的,避免插件操作与你的个人会话混在一起;登录态是否跨重启保留由 `cookies.persist` 决定。

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
| `src/browser-electron/` | provider 与三种载体实现 —— 桌面侧栏桥(`desktop-bridge-host.ts`)、本机浏览器(`system-browser.ts`)、自托管子进程(`host-main.ts`);传输层 `bridge-connection.ts`;以及设置、历史、虚拟光标 |
| `src/tool-browser/` | 模型侧 `browser_*` 工具 |
| `src/types/` | electron 环境类型(shim,避免强制依赖 electron 类型) |
| `desktop-bridge/` | 装进桌面端的那条 bridge 与幂等安装脚本(`install.mjs`) |
| `tools/` | 运维脚本(如 `install-web-plugin.mjs`:钉版本 → 安装 → 修复 profile → 复验) |

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
| 第十三轮 | 2026-08-28 | **macOS/Linux 输入框无法键入修复**(issue #7):0.1.16 引入的 Windows 焦点路由(mousedown 强制 focus + 窗口 refocus 恢复)未做平台判断,与 macOS 原生 click-to-focus 冲突导致登录框收不到键入 → 两处焦点逻辑加 `win32` 平台门,非 Windows 恢复原生行为 |
| 第十四轮 | 2026-08-28 | **window.open/target=_blank 新开标签**(issue #8):HTTP(S) 弹窗不再 loadURL 覆盖当前视图,转交父进程在**同一会话窗口新开标签**——原页面与 opener 上下文保留(门户「工作台」类跳转不再 403),跳转计入会话历史;未分组视图保留回退;非 HTTP 弹窗仍放行系统 |
| **0.1.21** | 2026-08-28 | **发布**:第十三/十四轮随 **0.1.21** 发布(构建零错误、25 项测试全绿) |
| macOS 二进制探测 | 2026-09-09 | **Electron.app 布局探测**(issue #9 / #14):`electronDistExe()` 只认 `dist/electron(.exe)`,macOS 的 `dist/Electron.app/Contents/MacOS/Electron` 永远找不到 → 共用平台探测补 darwin 候选路径(bundled 与 profile/anchor 两层同时受益);新增回归测试 |
| 第十五轮 | 2026-09-16 | **工具栏脚本解析期 SyntaxError**(issue #11):内联脚本 `const bridge = window.bridge` 与 `contextBridge.exposeInMainWorld` 装上的不可配置全局冲突(`HasRestrictedGlobalProperty`)→ **解析期** early error,整段脚本一行都不执行(地址栏回车 / 四个导航按钮 / 标签条 / 错误条全失效)→ 整段包进 IIFE 并把句柄改名 `tb`,从结构上杜绝同类冲突;新增 3 个工具栏回归测试(从**发布产物**解析出脚本、在 `vm` 里按 contextBridge 语义真执行) |
| 第十六轮 | 2026-09-16 | **自托管三连修复**(issue #10):① `browser_open` 用 `performance.timeOrigin` 指纹 + `readyState` 有界(5s)等新文档 settle,不再返回"有标题、0 元素"的空快照;② 新增等待式 `presentView` 屏障(先 materialize 视图再 showView,再发 ping 屏障;子进程消息严格串行),`click`/`type`/`key` 派发 `Input.*` 前必须 present,失败明确报 `BROWSER_VIEW_NOT_PRESENTED` 而非假报成功;③ `createView` 前有界加载 `about:blank`,新视图必有渲染进程(宿主重启后卡死的根因);④ `did-navigate` 标记强制重呈现、命令 20s 有界超时、子进程 stderr 与退出码落 `$DSH_HOME/logs/dsh-builtin-browser-host.log`(2MB 自截断)、`locateTab` 兼容裸 uuid 与 `tab:<uuid>` |
| 第十七轮 | 2026-09-16 | **截图 savePath 收敛 + 下载目录本地化**(issue #13):`browser_screenshot` 原先直接 `writeFileSync`,可写进程可达的任意路径并**静默覆盖**已有文件(等于绕过只读沙箱的写保护)→ 抽出唯一下载/截图共用准入门 `admitSavePath`(绝对路径 + `downloadDir` 内 + **不覆盖已存在文件**),截图补父目录自动创建;默认下载目录不再写死 `~/Downloads`,按序探测 `downloadDir` → `XDG_DOWNLOAD_DIR` → `~/Downloads`/`~/下载`/`~/下載` → 回退(中文桌面免配置) |
| **0.1.22** | 2026-09-16 | **发布**:macOS 二进制探测修复(issue #9 / #14)与第十五~十七轮(issue #11 工具栏 SyntaxError / #10 自托管三连 / #13 截图 savePath + 下载目录)随 **0.1.22** 收录(构建零错误、**35 项测试全绿**,tag `v0.1.22`) |
| 第十八轮 | 2026-09-20 | **Windows 真机三连 + 探测自愈 + 定位判词**(真实 `dsh web` 自托管宿主实测,缺陷①~④同为「CDP 报成功、页面没收到」):① Windows 的 `CalculateNativeWinOcclusion` 把被遮挡的插件窗口判定为 HIDDEN → 整站停帧,且每条合成鼠标/键盘事件被渲染端静默丢弃(CanReceiveInput=false)而 CDP 回 `{}` → 子进程 ready 前追加 `disable-features=CalculateNativeWinOcclusion`(仅 win32);② `click()` 缺前置 `mouseMoved`,新视图第一次点击落空 → 改为 move→press→release;③ 新视图从未持有 web focus,`browser_key` 第一次调用无效 → 宿主新增 `focus` op(view handle 可选 `focus?()`),`key()` 派发前 best-effort 聚焦,并在焦点需要移动时等 80ms(焦点落地异步,同轮派发的键仍会被丢);④ `available()` 把**失败**探测按宿主生命周期永久缓存,而 provider 选择每进程一次 → Electron 晚于 DSH 到位就永远接不上 → 成功仍缓存、失败 30s 冷却后重探(`DSH_BROWSER_PROBE_RETRY_MS`),`resolveProvider()` 报错区分「一个都没注册」与「注册了但自报不可用」并附处置;⑤ **定位失败被外层超时掩盖** —— 页内定位脚本会把预算轮询到底才回答,外层却用同一个预算,于是 `browser: click timed out after 10000ms` 抢走了页内早已写好的判词;而 css/xpath **解析失败**(选择器根本不合法)也被写成「还没找到」,对着永远不可能匹配的东西把预算轮完 → 解析失败即刻终止并报 `invalid CSS selector "…" / invalid XPath …`;外层给页内判词 2s 传输余量;未命中判词补上提供方实际采用的策略(`by` 缺省即 `"by":"css"`)与实际耗时;`scrape` 的 item 选择器同样即刻失败(同一个漏写 `by` 的调用:修前 `click timed out after 10000ms`,修后 `element not found: {"value":"Learn more","by":"css"} (looked for 10000ms)`);新增 7 条回归测试(**47/47 全绿**),真实宿主端到端 **17/17** + 定位判词 **4/4** |
| 第十九轮 | 2026-10-01 | **DSH 0.2 兼容性**:DSH 进入 0.2 线(`@deepseek-ai/dsh@0.2.0-rc.2`,peer 包 `dsh-llm`/`dsh-tools`/`dsh-system-prompt` 同步到 `0.2.0-rc.2`),而原声明 `>=0.1.1-rc.1 <0.2.0` 把 0.2 挡在门外 → 在**真实 0.2.0-rc.2 宿主**上实测插件的运行时依赖面(`cordis` 的 Context/Service、`dsh-tools` 的 defineTool、`dsh-llm` 的 HarnessError、`schemastery`),确认无破坏性变更:会话、导航、快照、截图三态(越界拒绝/合法写入/覆盖拒绝)全部通过 → `peerDependencies` 三个 dsh 包范围改为 `>=0.1.1-rc.2 <0.3.0`,`dsh.compatibility.dsh` 放宽为 `>=0.1.1-rc.1 <0.3.0`,`dshReleases` 增加 `0.2.0-rc.1`/`0.2.0-rc.2` = compatible |
| **0.1.23** | 2026-10-01 | **发布**:第十八轮(PR #15:Windows 合成输入三连 + Electron 探测自愈 + 定位判词)与第十九轮(DSH 0.2 兼容)随 **0.1.23** 发布(构建零错误、**47 项测试全绿**,tag `v0.1.23`) |
| 第二十轮 | 2026-10-01 | **浏览历史 / 设置栏 / 可视化鼠标 / 收尾语义**:①新增**持久化浏览历史**(`history-store`:追加式 JSONL,落在 cookie 同一 profile 目录;5000 条或 90 天先到者为准;损坏行只丢该行)+ 新工具 **`browser_visited`**(工具数 **33 → 34**),重新打开沿用 `browser_open`;②新增设置页「浏览器」栏(手写客户端 bundle 注册到 `settings.section`,`order: 60` 排在宿主自带栏目下方)+ `GET/PUT /dsh-builtin-browser/settings`(同源防护、64 KiB 上限)+ 设置文档(`settings-store`:字段逐个校验、未知键丢弃、损坏文件按默认值),**开关即时生效**(provider 每次读取,无需重启);③新增页面内**虚拟光标**(内联样式 + Web Animations 以规避页面 `style-src` CSP;`buildTargetScript` 统一附加元素中心 `__point`,于是 click / type / setValue / check / select / clear **都有落点**),**光标出现即代表 agent 已接管该标签页**;④**关掉窗口 = 结束该会话**:窗口 `closed` 时释放其全部视图的 `webContents`(BrowserWindow 不连带销毁子视图,否则每个窗口泄漏一个渲染进程)并上报 `viewClosed`,provider 结束对应会话,seam 新增 `exists()` 供工具层核验会话缓存 —— 下一次调用得到**干净的新会话**,浏览历史与登录状态保留;新增 21 条测试(**68/68 全绿**) |
| 第二十轮补记 | 2026-10-01 | **客户端设置栏"隐形"的根因 + 崩溃诊断**:①真机验证发现设置栏不出现 —— 根因是 `cordis.patch.yml` 三行全用**子路径名**(`dsh-builtin-browser/browser`)注册,而宿主的客户端模块扫描只接受**精确包名**(`exactPackageSpecifier` 遇 `/` 即返回 `undefined`),于是这个包在客户端侧没有任何行可供读取 `dsh.client`;修复 = 增加一行以**包名**注册的惰性根行 + 给根入口补 `export const name` 与空 `apply()`;实测启动图条目 67 → **68**、设置栏出现并排在「规则设定」下方、开关即时落盘。②宿主日志三处缺陷修复:加 **ISO 时间戳**、spawn 前记录 **两条路径与存在性**、2 MiB 轮转改为**留时间戳标记**(原先整体清空,几周历史就是这样消失的);`exit` 行加 `pid=`/`entryExists=`,使"启动时存在、退出时不存在"自动命名"安装被就地替换"。③修复**测试污染真实日志**:三个 spawn 类测试因 `dispose()` 异步杀子进程,exit 行写在 `finally` 恢复 `DSH_HOME` 之后 → 改为模块级隔离。测试 **70/70** |
| **0.2.0** | 2026-10-01 | **发布**:第二十轮(浏览历史持久化 / 设置页「浏览器」栏 / 可视化鼠标 / 收尾语义)及其补记随 **0.2.0** 发布 —— 工具数 **33 → 34**(新增 `browser_visited`),设置页新增「浏览器」栏。构建零错误、**70/70 测试全绿**,tag `v0.2.0` |
| 第二十一轮 | 2026-10-01 | **桌面端改由官方侧栏承载(人机同页)**:DSH Desktop 是"Electron 外壳 + Node 模式宿主"两层,插件跑在宿主里(无 Electron API),而 0.2 移除了 `electronViewHost`、宿主与外壳之间也没有承载视图的通道 → 插件借道一条 **loopback + token 的 bridge**(装在外壳主进程,经 `install.mjs` 幂等安装/可 `--revert`),把侧栏浏览器 guest 的 CDP 交给插件。结果:**agent 操作的页面就是人看到的那个页面**,不再 spawn 自带 Electron、不再多出窗口。过程中被实测纠正三处想当然:侧栏 guest 是**懒创建**的(空地址栏没有 webContents);地址栏那条路不可靠(React 受控输入忽略合成键盘事件、focus 被重渲染夺走),改用侧栏自带的**「恢复页面」**逼出 guest 再纯 CDP 导航;endpoint 文件必须**反复刷新**,否则读者拿到已退出实例的地址 |
| 第二十二轮 | 2026-10-01 | **issue #16:错误上报路径不得致命**:`notifyUserActionError` 把宿主方法取出后**非绑定调用**,宿主第一句 `void this.ready()` 抛 TypeError,且该异常在 async catch 里变成 unhandled rejection → **整个 DSH 宿主退出 1**;即便绑定正确,`ready()` 在已 dispose 时**同步抛**也逃出 `.catch`。修复 = 在属主上调用 + 全程容错;`ready()` 改为返回 rejected promise(并标记已处理)。回归测试 4 条,含用报告里那个会读 `this` 的 stub 驱动的失败工具栏动作 |
| 第二十三轮 | 2026-10-01 | **CVE-2026-84961(undici)**:CVE 真实,但收到的自动修复**在本仓库失效** —— `pnpm.overrides` 写在 `package.json` 里,pnpm 10 起已不再读取该字段(实测打印警告并忽略,lock 仍是 7.29.0)。改在 **`pnpm-workspace.yaml`**(新位置)锁 `undici: 7.29.1`,同大版本不做无收益跳跃。影响面已澄清:插件不 import undici,发布物也不含 `node_modules` |
| 第二十四轮 | 2026-10-01 | **需求表 v2 逐条落地**:①**视觉策略真正接线** —— `nonVisual` 下坐标点击被**明确拒绝并给出可执行替代**、工具描述改为语义优先(此前该设置项存了却无人读取);②**非视觉输出增强** —— 快照按 `depth` 缩进、坐标改按需(`coords: true`)、去空 states,`content(txt)` 改用浏览器渲染文本;③**沙箱边界变化明示**(两份 README + 设置面板);④`closeWithSession` / `autoExpandOnce` 真正生效(bridge 新增 `closeSidebarBrowser`、`collapseSidebar`);⑤**每会话独占一个侧栏标签**,释放只关自己的;⑥历史新增**关键词与来源会话**过滤;⑦光标新增**操作气泡**。顺带修掉 6 个实测 bug(逐字动画文本被拆成一列字母、重启后首次调用必失败、三个设置项是死的、释放会关掉别人的标签、设置文件带 BOM 时全部设置被静默丢弃) |
| 第二十五轮 | 2026-10-01 | **速度优化 + 结构拆分**:真机量化出每条命令 **49.1ms** 的结构性开销(新建 TCP 连接含 token 往返 24.8ms + 每条命令前的存活检查 24ms),复用连接只需 **0.2ms** → 改为**长连接 + 请求串行**,并把存活判定改为"命令失败才重建"。传输层拆成独立模块 `bridge-connection.ts`(`desktop-bridge-host.ts` 426 → 306 行)。光标：位置未变时不再重绘、缓动改 190ms、新增 `forgetCursor`(文档替换后必须清缓存,否则导航后指针再也不出现) |
| 第二十六轮 | 2026-10-01 | **可选用本机 Chrome / Edge**:设置里可选 `bundled` / `auto` / `chrome` / `edge`,做法与 Codex Browser Use 一致 —— `--remote-debugging-port=0` 启动、读浏览器自己写下的 `DevToolsActivePort` 取端口、全程走 CDP(用 Node 22 内置 `WebSocket`,**零新增依赖**)。**用户日常数据不被触碰**(独立 profile);登录态按 `cookies.persist` 决定保留或丢弃。优先级:显式选择 > 桌面侧栏 > 自托管;缺失时记录警告并继续用内置(后续细化:`自动` 仍会回退,但**明确选择**时改为**报出找不到的那个浏览器**,不再悄悄换一个) |
| **0.3.0** | 2026-10-01 | **发布**:第二十一~二十六轮合并发布(桌面端侧栏载体、可选本机浏览器、需求表 v2 全部落地)。**99/99 测试全绿**,tag `v0.3.0` |
| 第二十七轮 | 2026-10-01 | **系统浏览器只在需要时启动**(上报的 bug)+ 收尾加固:此前 entry 在注册时就 `await launch()`,于是**一装好插件就弹出浏览器**,连"启动 DSH"都会拉起它 → 改为**构造惰性、首次需要页面才启动**(并合并并发启动);自查又补两处边界:释放后的宿主**拒绝启动**(否则会拉起没人管的进程)、启动过程中被释放则**停止轮询并拒绝发布客户端**(否则留下悬空连接)。另新增 `tools/install-web-plugin.mjs` 把"改 pin → install → **立即修复 profile** → 复验"固化为一条命令,并移除 CHANGELOG 里机器用户名 |
| **0.3.1** | 2026-10-01 | **发布**:第二十七轮(惰性启动 + 释放后拒绝启动)随 **0.3.1** 发布。**100/100 测试全绿**,tag `v0.3.1` |

> registry 上的最新版本以顶部 npm 徽章为准(当前 `0.3.1`)。桌面端升级后需重跑一次 `node desktop-bridge/install.mjs`;Web 端无此步骤 —— 详见[更新方式](#更新方式两端不同)。

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队:本插件的 seam、工具运行时与插件体系都构建在这个项目之上。

同时感谢 [Cordis](https://github.com/cordiverse/cordis) 提供的插件化基础,以及所有参与讨论、测试、反馈和插件开发的社区成员。

## 作者的话

对插件本身有意见或者有想要制作的其他插件,欢迎加我微信来讨论:

**wx:`hui13866591135`**(请在申请好友时注明)

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是 DeepSeek Harness 的社区插件,并非 DeepSeek 官方产品。
