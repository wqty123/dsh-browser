# 架构说明

## 三层结构

```
agent (dsh_browser_* 工具)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (由宿主外壳提供)
  → WebContentsView + webContents.debugger (CDP)
```

### seam 层(`src/browser/`)

`BrowserRuntime` 以 Cordis Service 形式注册为 `ctx.browser`:

- **provider 注册**:`registerBrowserProvider(provider)` 登记一个实现 `BrowserProvider` 接口的 provider,重名抛 `BROWSER_DUPLICATE_PROVIDER`;disposer 挂在注册方自身的 fiber 上,插件重载时正确清理。
- **provider 选择**(执行期解析,不依赖顺序):
  - 配置了 id 且注册且可用 → 该 provider
  - 配置了 id 但未注册 → `BROWSER_PROVIDER_CONFIGURED_MISSING`
  - 配置了 id 但不可用 → `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`
  - 未配置、恰一个可用 → 自动选择
  - 未配置、多个可用 → `BROWSER_PROVIDER_AMBIGUOUS`
  - 未配置、无可用 → `BROWSER_PROVIDER_UNAVAILABLE`
- 所有请求/结果类型(`BrowserProvider` 接口、`BrowserError` 错误码)定义在 `src/browser/types.ts`。

### provider 层(`src/browser-electron/`)

`ElectronBrowserProvider` 通过 `ElectronBrowserViewHost` 接缝操作视图,与 Electron 解耦:

- 会话 = 有序标签列表 + 历史;每次 `open()` 新建会话(工具层按任务缓存复用);
- 每个标签对应一个视图(handle);`showActive` 让宿主把活动标签的视图置顶;
- 页面驱动全部走 CDP:`Page.navigate` / `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Input.insertText` / `Page.captureScreenshot`(兜底);
- **截图优先走宿主原生 `capturePage`**(新增 `capture` 通道):CDP `captureScreenshot` 在窗口存在多个(隐藏)视图时会挂起,原生捕获对可见视图快速可靠,失败时自动回退 CDP(临时摘除其他视图保证单视图状态);
- 所有 CDP 调用都有超时兜底(`withTimeout`),避免卡死工具调用;
- 历史记录单调递增的 seq,截断(500 条)后不回绕;失败导航只记一条。

### 工具层(`src/tool-browser/`)

34 个 `dsh_browser_*` 工具,按**调用方任务**(`exec.agent.id`)维护独立浏览器会话:

- 会话缓存 `sessionsByTask`:同一任务复用同一会话,并发首开去重;
- `dsh_browser_reset_session` 关闭本任务会话并遗忘映射(即使 close 抛错也清除,下次调用重建);
- 会话生命周期绑定 agent 作用域 ctx:agent(DSH 会话)销毁时自动关闭对应浏览器会话,任务结束后不再泄漏窗口/视图;
- 会话/开启动态/白名单都是**每插件实例(每 context)作用域**的,多 context 互不共享、互不污染;
- `dsh_browser_restrict` 维护本任务白名单,守卫所有非只读工具;
- 输出 schema 与返回值严格一致(DSH 运行时会校验,`additionalProperties: false` 下多一个字段都会报错):元素与节点的字段集在 `element-fields.ts` 里**只声明一次**,item schema 与投影都由它导出 —— 手写白名单漏一个字段会**静默丢数据**、多一个会让**整个结果被拒**,同源之后这两个方向都不可能单独出错(`dsh_browser_a11y` 的 `selector` 与 `dsh_browser_screenshot` 的 `width`/`height` 都是这么丢的)。

### 输出尺寸(工具层)

工具输出花的是调用方的上下文,所以工具层对几处返回设了明确上限,并在截断时**说明截断**:

- `dsh_browser_a11y` 默认 150 个节点(上限 5000)、一层一个空格缩进、`states` 只省略字面量 `enabled`(`unchecked`、`collapsed` 等仍会打印);
- `dsh_browser_snapshot` 与 `dsh_browser_a11y` 在元素有 `id`/`name` 时给出 `{#id}` / `{[name=x]}` 引用选择器(页面脚本一直算,工具层此前丢掉;输出 schema 必须声明该字段,否则 `additionalProperties: false` 会拒绝整个结果);
- `dsh_browser_content` 的上限按格式:html/json 50 000,txt/markdown 20 000,`maxChars` 可覆盖;
- `dsh_browser_execute` 的返回值上限 50 000 字符;
- `dsh_browser_scrape` 输出紧凑 JSON;`dsh_browser_history` 默认只渲染最近 20 条且不回显参数(`verbose: true` 才带);`dsh_browser_visited` 的时间戳精确到分钟、会话标记只在变化时打印一次。

## 自托管实现(纯 `dsh web`)

没有桌面外壳时,`RemoteElectronViewHost` 接管:

```
父进程(DSH)                        子进程(Electron main)
RemoteElectronViewHost  ──TCP JSON-RPC──▶  host-main.js
  resolveElectronPath()                    BrowserWindow('dsh-browser')
  ElectronChildClient                      WebContentsView × N
  DeferredRemoteView(物化缓存)              webContents.debugger(CDP)
```

- **协议**:本机 loopback TCP,每行一个 JSON(`{ id, op, ... }` ↔ `{ id, ok, result|err }`);op 名清单只写在 `rpc-ops.ts` 一处,并由一个读**子端 switch 与父端调用两侧源码**的测试断言一致 —— 单侧改名因此会当场失败,而不是编译通过、运行时报 "unknown op";
- **认证**:每次 spawn 生成随机 token,经 **stdin 首行 + `DSH_BROWSER_RPC_TOKEN` 环境变量双通道**传给子进程(绝不进 argv,避免进程列表泄露;Windows GUI 进程收不到 piped stdin,环境变量兜底),子进程首条消息必须回传该 token(`hello`);服务端只接受**一个**连接,其余连接直接断开——本机其他进程无法伪冒子进程或注入回复;
- **Electron 定位**:① `ELECTRON_PATH`(显式覆盖,优先于一切自动发现)→ ② 随插件安装的 electron 包(纯文件系统探测,含 pnpm store 布局,不触发 44+ 懒下载)→ ③ 锚点与 pnpm store 中**版本最新**者(33.x 有合成器缺陷,建议 ≥ 40)→ ④ 当前进程是**裸** Electron(dev 模式)时复用宿主二进制(`process.execPath`)→ ⑤ 进程祖先树中的裸 Electron 二进制(Windows 用 PowerShell CIM 查询,仅在其它路径全部落空时才执行)。**打包应用不参与复用**:旁有 `resources/app.asar` 的可执行文件(如 DSH Desktop.exe)不能按脚本参数拉起——spawn 会启动应用本体并秒退(单实例锁,即 "browser host exited (code=0)"),一律跳过;
- **稳健性**:子进程/套接字都有 `error` 监听(否则未捕获事件会炸掉整个 DSH 进程);子进程退出自动重启,已物化的视图句柄在下次调用时**自动重建并重试一次**(会话跨崩溃存活,仅页面状态丢失,不再出现 "browser host is not running" 僵尸态);物化失败可重试;下载仅限 HTTP(S)、`savePath` 必须绝对路径(`downloadDir` 已配置时用它;未配置时按序探测 —— 存在的 `XDG_DOWNLOAD_DIR` → home 下第一个存在的 `Downloads`/`下载`/`下載` → 回退 `~/Downloads`,首次使用时创建)、流式限流 + Content-Length 提前拒绝、256MB 上限与 60s 超时,文件由**子进程直接落盘**(临时文件 + rename,不再经 RPC 传 base64);cookie 导出/恢复有 30s 超时,两者受**不同**的门控:导出是**读**动作,读 `credentials.allowRead`,关闭时抛 `BROWSER_AUTH_DISABLED`;恢复是**写**动作,读 `actions.allowCredentialWrite`,关闭时抛 `BROWSER_AUTH_WRITE_DISABLED`(允许读取的操作者因此仍能拒绝写入)。有原生方法时优先用它,否则走 CDP 的 `Network.getCookies` / `Storage.setCookies`(三种载体都可用);**导出的范围收敛到本会话当前所在页面的 URL**,页面 URL 取不到时**拒绝而不是放宽**(CDP 载体报 `BROWSER_AUTH_SCOPE_UNKNOWN`,自托管侧栏按 view 自己的 URL 过滤);`cookies.get`/`cookies.set`(后者每条 cookie 一次)与下载的 `Runtime.evaluate` 都套同一套 `COMMAND_TIMEOUT_MS` —— 这三条曾经是无上限的 await,会让串行操作队列永久停在那一条上;
- **视图可见性**:多标签/多会话时,`showView` 隐藏其他视图并把目标视图置顶(remove+re-add),确保用户看到的是活动标签;目标是当前可见视图时**跳过** remove/re-add(否则每次操作都闪烁);窗口标题实时显示当前可见会话的任务标识 + 页面标题/URL(`showView` 携带会话 label,子进程读 `getTitle`/`getURL`);窗口 resize 时视图 bounds 自动跟随;
- **孤儿防护**:父进程断开时子进程自动退出,不留僵尸窗口;
- **cookie 落盘**:子进程使用独立 userData 目录(`<DSH_HOME>/dsh-builtin-browser-host`),登录态跨重启保留(另有 `dsh_browser_auth` 手动导出/恢复)。

## 关键设计决策

| 决策 | 原因 |
| --- | --- |
| 任务级会话隔离,共享 cookie | 并行任务不抢页面;登录一次到处可用 |
| 原生 capturePage 优先,CDP 兜底 | CDP 截图多视图挂起;原生捕获窗口未激活时失败——两通道互补 |
| 自动选最新 Electron | 33.x 合成器缺陷导致截图间歇失败 |
| 独立 userData | 多实例争用默认目录导致 GPU 缓存/会话锁冲突 |
| withTimeout 全覆盖 | 卡死的 CDP 调用必须能被工具超时兜底 |
| 输出 schema 严格匹配 | DSH 运行时会校验返回值,多字段即报错 |

## 载体与桌面外壳的分工

插件会自动选载体,也可以在设置里指定。共四种,优先级是:**设置里显式选择的本机浏览器 > 桌面端侧栏 > 自托管**。

### ① 桌面端:驱动官方侧栏的页面(人机同页)

DSH Desktop 是两层结构:Electron 外壳 + 一个 `--expose-internals` 的 **Node 模式宿主**(插件就跑在宿主里,**没有 Electron API**)。0.2 移除了 `electronViewHost`,宿主与外壳之间也没有任何承载视图的通道,所以插件**借道一条小桥**:外壳主进程里跑一个 loopback + token 的 bridge,把侧栏浏览器的 guest(就是界面上那个页面)的 CDP 交给插件。

结果是:**agent 操作的页面就是人看的页面**,插件不再 spawn 自己的 Electron,也不再出现第二个窗口。

**页面落在哪个会话,由发起的会话决定,与屏幕上显示谁无关。** 外壳为每个会话各挂一个侧栏,而插件的渲染侧半边按**会话 id** 打开那一会话自己的面板(DSH 的 `openTabIn`),不读"当前显示的是谁" —— 所以"在 A 里让 agent 开页面、随后切到 B"不会把页面开到 B 去,结构上也没有通往别人侧栏的路径。

> **一条来自外壳的行为**:外壳只渲染**当前显示会话**的侧栏。因此当发起会话不是屏幕上那个时,面板会被建立(它的标签确实进了那个会话),但页面要等该会话被显示时才附着上来。表现是:切走后在 A 里再让 agent 开页面,会得到一句"面板已放置,页面只能在被显示时附着",而 A 的侧栏此后一直是它自己的样子 —— **那是提示,不是串扰**。

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
> - Agent 能读到该 partition 中的 **Cookie / 登录态**,`dsh_browser_auth` 可将其导出(由设置项控制);
> - 反过来,你在侧栏里的操作与 Agent 的操作**作用于同一个页面**,可能互相影响(Agent 不会主动覆盖你的输入,但导航会改变双方看到的内容)。
>
> 这是"人机同页"的必然代价。我们认为值得(它把"Agent 在一个你看不见的窗口里操作"变成"你能看着它操作并随时接手"),但你有权知道它存在 —— 因此也提供了开关:**「凭据访问」关闭后 `dsh_browser_auth` 的导出会被拒绝(`BROWSER_AUTH_DISABLED`)—— 它只管读;写入登录态(`restore`)另有「允许写入登录状态」开关,报 `BROWSER_AUTH_WRITE_DISABLED`,两者独立**;**「视觉策略」设为纯非视觉后,任何依赖截图定位的坐标点击都会被拒绝**。不想接受这个边界变化时,把 desktop profile 里的插件移除即可回到"独立窗口"的旧形态。

### ② 用你自己的浏览器(Chrome / Edge)

设置里可以把载体改成**本机已安装的 Chrome 或 Edge**(`browser.channel`:`bundled` / `auto` / `chrome` / `edge`)。做法与 Codex Browser Use 一致:以 `--remote-debugging-port=0` 启动,读浏览器自己写下的 `DevToolsActivePort` 得到端口,再全程走 CDP(用 Node 22 内置的 `WebSocket`,**不新增依赖**)。

**你自己的数据不会被碰**:插件用的是**独立 profile**(`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`),不会打开、占用或修改你日常的窗口、书签与登录状态;插件退出也不会关掉你的浏览器。

**浏览器死了之后会自己回来**:这个载体会观察子进程的退出并清掉**已失效的会话映射**(不只是缓存里的连接),所以重启后的浏览器是**可用的**,而不是"活着但每条命令都报 Session not found"。重新拉起前会先 kill 旧进程并**最多等 3 秒**它真正退出(Windows 上 `kill` 是异步的,不等就会把新进程交给旧实例、然后被误报成"路径不是可运行的浏览器"),并**删掉上一轮写下的 `DevToolsActivePort`、只认本次启动之后写入的那份**(否则会连到别的 Chromium 或 `node --inspect` 上,发布一个自己既不属于、也杀不掉的客户端)。

反过来,**页面慢不等于浏览器死了**:命令**超时**只把连接标记为"存疑",下一次调用先用 `Browser.getVersion` 探一次再决定是否丢弃;只有**socket 已关闭**才直接重启 —— 因此一次慢页面不会让插件杀掉你正在用的浏览器窗口、连你打开的标签和填到一半的表单一起丢掉。

同一套判活也用在桌面侧栏那条桥上,但判据不同:桥的端点文件由外壳的 keep-alive **每 15 秒重写一次**,所以一个**超过一分钟没被刷新**的端点被判定为墓碑(那是退出的外壳留下的最后一份写入),插件据此报告载体已消失并换回自托管 —— 而不是对着一个没人监听的端口一直发命令。

**登录态怎么办**:

- `cookies.persist` **开**(默认)→ 上面那个固定 profile 会保留,**重启 DSH 后仍是登录状态**;`dsh_browser_auth` 也照常可导出/恢复该 profile 的 Cookie。
- `cookies.persist` **关** → 每次用**临时 profile**,释放浏览器时整个目录被删除,不留登录痕迹。**进程被强杀时释放路径跑不到**,所以下一次启动会**先清扫**上一轮残留的临时 profile —— 只清"属主进程已不在 **且** 一小时没有写入"的那些,免得删掉仍在运行的孤儿浏览器正在用的目录。
- 代价要说清:独立 profile **看不到**你日常浏览器里已登录的站点 —— 在插件打开的窗口里登录一次即可,之后登录态就存在它自己的 profile 里。

### ③ 有 `electronViewHost` 的宿主(旧版桌面外壳)

直接使用外壳提供的视图。

### ④ 没有外壳(纯 `dsh web`)

自托管 —— spawn 插件自带的 Electron 窗口,功能照常。

> 可见视图与列布局始终属于宿主外壳;插件只负责 seam、provider 与工具。各形态下**工具集、浏览历史、设置栏、可视化鼠标、收尾语义完全一致**,差别只在页面由谁承载。

### 载体缺失时

分两种处理:`自动` 的语义就是"哪个都行",找不到 Chrome/Edge 时**记一条警告并继续用内置**;**明确选了某个浏览器**而它没装时则不再只写日志 —— 插件改挂一个只会解释原因的载体,**每次命令都向调用方报出找不到的是哪个浏览器、查过哪些名字与位置,以及三条出路**(装上它 / 用 `DSH_BROWSER_CHROME_PATH`、`DSH_BROWSER_EDGE_PATH` 指定路径 / 把载体改回 `内置` 或 `自动`),不会让人对着一条关于 Electron 的错误去猜真正的原因。

### 载体切换是实时的

`browser.channel` 在设置里改动后**当场生效**,不需要重启 DSH:设置路由在写入改变 channel 时重跑一次载体选择,换掉旧载体并释放它。响应里带 `carrierRechosen: true` 与"只存了"区分开。

**代价明说**:换载体意味着**关掉旧载体上开着的页面** —— 换浏览器本来就是这个意思。如果你改设置时正好开着东西,那些页面会消失;这是刻意的(比留一个看不见的载体继续活着强,否则会有两个浏览器实例、两套登录态,而用户只知道自己改了一个设置)。
