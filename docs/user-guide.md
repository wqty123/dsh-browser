# 用户指南

## 环境要求

- DeepSeek Harness(dsh),已安装对应 profile(`web` / `desktop` 等)
- **Electron 运行时**(必装依赖,随插件自动安装):
  - **DSH Desktop**:侧栏可驱动时使用外壳的页面;自托管回退使用插件的 electron。打包宿主 exe(`DSH Desktop.exe`)**不能作为自托管运行时复用**——打包应用无法按脚本参数拉起,误用会秒退(issue #6);开发模式的**裸** Electron 宿主仍可复用;
  - **纯 `dsh web` 自托管**:使用随插件安装的 electron 包。0.4.16 声明 `^44.10.0`(即 `>=44.10.0 <45`),锁文件解析到 `44.10.0`;本插件在获准执行安装脚本时准备二进制,需网络,详见下节。

## 安装

```sh
# 从 npm 安装(已发布);`--profile` 换成你实际使用的 profile(DSH Desktop 为 `desktop`)
dsh plugin --profile web add dsh-builtin-browser

# 或从源码目录(独立仓库,一插件一仓库)
dsh plugin --profile web add <本仓库路径>
```

安装会链接插件、把 `dsh-builtin-browser` 加入 profile 的 bundle 层,并挂载四行(一个惰性的根行 + 三个功能行):

| 行 | 子路径 | 角色 |
| --- | --- | --- |
| `dsh-builtin-browser` | 包名本身 | **惰性根行**:不注册任何东西(空 `apply()`),只用来声明包名 —— 宿主的客户端插件扫描靠精确包名读到 `dsh.client`,少了这行设置栏不会出现 |
| `browser` | `dsh-builtin-browser/browser` | `ctx.browser` 能力 seam(始终挂载) |
| `browser-electron` | `dsh-builtin-browser/browser-electron` | Electron CDP provider |
| `tool-browser` | `dsh-builtin-browser/tool-browser` | `dsh_browser_*` 模型侧工具 |

> 没有桌面外壳时插件**自托管**:自己拉起一个标题为 `dsh-browser` 的 Electron 窗口,`dsh_browser_*` 工具照常可用。

### 准备 Electron 二进制

Electron 44 将二进制下载改为懒下载,仅安装 npm 包并不保证已有可执行文件。0.4.16 增加本插件的 `postinstall`:宿主允许安装脚本且下载可用时,明确运行所依赖 electron 包的 `install.js`,通常在安装阶段就准备好二进制。下载失败会保留错误并返回非零退出码,应先处理错误再重试。

**DSH rc.5 使用 pnpm 11.7 的 `strict-dep-builds`。** 首次安装若提示构建脚本尚未批准,请在宿主原生插件管理器中审阅并批准 `dsh-builtin-browser` 的构建脚本,再按宿主提示重试安装或构建。插件不会自行改写 `allowBuilds`;审批和宿主策略仍由用户控制。

使用 `--ignore-scripts`、明确跳过下载,或需要重试下载时,进入**安装本插件的 profile 目录**(通常为 `$DSH_HOME/profiles/web` 或 `$DSH_HOME/profiles/desktop`),运行本插件已经安装的本地命令:

```sh
npx --no dsh-browser-install-electron
```

`--no` 用于拒绝临时下载缺失命令;命令不存在时先检查 profile 与插件安装,不要改用同名第三方包。该命令与安装脚本都遵守 `ELECTRON_SKIP_BINARY_DOWNLOAD`:若之前有意设置该变量,需要下载时先撤销跳过设置,否则继续跳过。离线部署可保留跳过设置并预装合适的裸 Electron,通过 `ELECTRON_PATH` 指向它。只有明确知道本插件所依赖 electron 包目录时,才可改用 `node "<已安装的 electron 包目录>/install.js"`。

## 配置

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 可选 | 宿主提供的 `ElectronBrowserViewHost`(通常 `!!js ctx.get('electronViewHost')`)。**不传时插件自己选载体**:桌面端驱动官方侧栏、否则自托管;设置里显式选择的 Chrome/Edge 优先于两者 |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;`file:`/`data:` 等拒绝 |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数 |
| `browser-electron` | `contentMaxChars` | 数字 | 未设置(按格式分档) | 内容抓取的字符上限。**不设**时按格式取分档默认(html 50 000、json 50 000、txt 20 000、markdown 20 000);**设了**就是操作者的值,覆盖分档默认。单次调用的 `maxChars` 优先级最高 |
| `browser-electron` | `downloadDir` | 字符串 | 系统下载目录(自动识别 `Downloads`/`下载`/`下載`,或 `XDG_DOWNLOAD_DIR`) | 限定 `dsh_browser_download` 与 `dsh_browser_screenshot` 保存路径必须位于该目录内且不覆盖已有文件;默认收敛到系统下载目录,可改沙箱目录 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具 |
| `tool-browser` | `allowedActions` | 字符串数组 | 不限制 | **部署级**动作白名单,对该部署里的每个任务生效(单个任务仍可用 `dsh_browser_restrict` 再收窄);`READ_ONLY_TOOLS` 与 `dsh_browser_restrict` 无论列表怎么写都不拦。`cordis.patch.yml` 默认给的是空 `config: {}`(等于不限制) |

## 快速上手(给 agent 的提示词示例)

```
1. dsh_browser_open 打开 https://example.com
2. 慢站点先 dsh_browser_wait(url=…) 等页面就绪,再 dsh_browser_snapshot 查看可交互元素
3. 需要填表时用 dsh_browser_fill(按 name/label/placeholder 匹配,一次填多个字段)
4. 需要截图确认时用 dsh_browser_screenshot(可 savePath 存文件,大页面用 maxWidth 缩小)
5. 需要滚动/回退/按键时用 dsh_browser_scroll / dsh_browser_back / dsh_browser_forward / dsh_browser_key
6. 遇到验证码(dsh_browser_challenge 或快照标注 CHALLENGE)时,停下请用户处理
7. 每次操作后告知用户你在页面上做了什么
```

## 操作纪律

**先确认视觉策略。** 设置里的 `vision.strategy` 决定坐标点击能不能用,**而且只决定这一件事**:

- **`auto`(默认)**:坐标与语义都允许,适合能读图的模型。
- **`nonVisual`**:**坐标点击被明确拒绝**,报 `BROWSER_NON_VISUAL_COORDINATES`,错误信息直接给出改法 —— 传语义 target,如 `target { by: "text", value: "Sign in" }`。**这是配置,不是故障,不要重试同一次坐标点击。**

**两种策略下 DOM 查询、无障碍树、文本提取与结构化抓取完全一致** —— 所以下面这些纪律对**所有模型**都成立,不是因为谁看不了图。

**定位:先用语义,再考虑坐标**

- **`dsh_browser_a11y` 是理解页面的首选**,它给出每个交互节点的**角色**(button/textbox/…)与**可访问名称**,比读 DOM 更接近"这页面上有什么";`dsh_browser_snapshot` 给出可点击元素的**引用与坐标**。
- **两者都带 `selector`**:无 id 且无 name 时是空串。**有 `selector` 就优先用它**,它比坐标稳定 —— 页面滚动、布局变化都不会让它失效,而坐标会。
- **优先用 DOM 语义而非坐标**:表单提交优先 `form.requestSubmit()`;点击优先 `element.click()`;坐标点击是最后手段。
- **`dsh_browser_click` 的 `target`(css/text)本质上就是语义定位**,能用它就别自己算坐标 —— 它会把元素滚进视野并在中心点击,坐标抖动、像素比、iframe 偏移都由它处理。
- **选中正确的元素**:页面常有隐藏副本(如移动端按钮),用 `dsh_browser_execute` 过滤可见元素(`getBoundingClientRect()` 宽高 > 0、`getComputedStyle` 非 `display:none`),再取坐标。
- **取坐标后立即点击**:中间不要插入其他操作(填表、滚动会移动元素,旧坐标立即失效)。
- **点击前验证命中**:`document.elementFromPoint(x, y)` 确认该坐标确实是目标元素,再执行真实点击。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

**截图与内容:先问"我要的是判断还是像素"**

- **能用文本就用文本。** `dsh_browser_snapshot` / `dsh_browser_a11y` / `dsh_browser_content` 给出同一页面的文本表示;**没有图像输入能力的模型看截图什么也得不到**,只会花钱。截图留给布局、图表、设计核对这类**必须看像素**的事。
- **`dsh_browser_screenshot` 带 `maxWidth`/`maxHeight` 时,结果里会返回 `width`/`height`**(实际像素尺寸)。需要控制成本时用它确认降采样生效了,而不是自己解码 data URL。
- **`dsh_browser_content` 的 `maxChars` 是按格式分档的**(html/json 默认 5 万,其余 2 万),单次传 `maxChars` 优先于设置里的 `contentMaxChars`。

**动作开关:三个门是操作者(人)的,不是你的**

设置页里的**执行页面脚本**、**下载文件到磁盘**、**写入登录态** 由人控制,**任何 `dsh_browser_*` 工具都改不了它们**。关掉时对应调用会明确报错,一眼能认出:

| 谁被关 | 报的错误码 | 哪些工具会遇到 |
| --- | --- | --- |
| 执行页面脚本 | `BROWSER_EXECUTE_DISABLED` | `dsh_browser_execute`、以及需要页内脚本的工具 |
| 下载文件到磁盘 | `BROWSER_DOWNLOAD_DISABLED` | `dsh_browser_download` |
| 写入登录态 | `BROWSER_AUTH_WRITE_DISABLED` | `dsh_browser_auth` 的 `restore` |
| 读取 cookie | `BROWSER_AUTH_DISABLED` | `dsh_browser_auth` 的 `flush` |

**看到这些码不要重试、不要绕路** —— **它是人的决定,不是可以克服的故障**,直接告诉人"需要他在设置里打开"。

另外几个容易认错来源的码:`BROWSER_DOWNLOAD_BLOCKED` / `BROWSER_SCREENSHOT_BLOCKED` 是**保存路径被沙箱拒绝**(不是开关问题,换路径而不是找开关);`BROWSER_DOWNLOAD_UNSUPPORTED` 是**该载体没有这个能力**(比如非自托管浏览器)。

`dsh_browser_restrict` **不一样** —— 那是**你自己**设的临时白名单,你有权设也有权解除;它不该被用来绕过上面三个门。

**失败怎么读**

- **`CDP error: ...` 是浏览器答了但拒绝**(比如元素已经不在)—— 多半是页面变了,重新快照再试,不要盲目重复同一动作。
- **超时 / 连接类错误**才是浏览器可能有问题;这类错误会触发一次自动探测,通常下一条命令就能恢复。
- **`BROWSER_SESSION_UNKNOWN`** 说明会话没了(浏览器被替换过);`dsh_browser_reset_session` 重建本任务的会话。
- **同一个动作连续失败两次就换策略**:换 `selector`、换语义定位、或者用 `dsh_browser_snapshot` 重新看页面 —— **不要第三次用同样的坐标**。

**`dsh_browser_history` 与动作集**

- `dsh_browser_history` **默认只给 20 条**,要更多自己传 `limit`。
- **可重放的动作有六种**:`navigate` / `click` / `type` / `scroll` / `key` / `execute`。不是每种历史记录都能 `dsh_browser_replay`,遇到不可重放的会明确报错。

## 多任务并行

每个 DSH 会话(任务)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰:

- `dsh_browser_session` 查看本任务的会话与标签;
- `dsh_browser_reset_session` 关闭并重建本任务的会话(崩溃或卡死后用它恢复)。

登录态(cookie)为所有任务共享;可用 `dsh_browser_auth` 导出/恢复,重启后不丢。注意 **`flush` 只导出当前页所属站点的 cookie**(按本会话所在页面的 URL 收敛),页面 URL 未知时**直接拒绝**而不是扩大范围去读整台机器的 cookie 罐;`restore` 会向任意域写 cookie,所以 `dsh_browser_auth` **同样受 `dsh_browser_restrict` 白名单约束**,不属于只读豁免。

## FAQ

**Q:纯 `dsh web` 能用吗?**
能。插件自托管:自己拉起 Electron 窗口,无需桌面外壳。

**Q:找不到 Electron?**
插件按顺序自动定位:① `ELECTRON_PATH` 环境变量(显式覆盖,优先于一切自动发现)→ ② 随插件安装的 electron 包(纯文件系统探测,不触发 44+ 懒下载)→ ③ DSH 锚点(profile / 全局 prefix 中单独安装的 electron)中版本最新者 → ④ 当前进程就是**裸** Electron(dev 模式)时复用宿主二进制 → ⑤ 进程祖先树中的裸 Electron 二进制。**打包应用不参与复用**:旁有 `resources/app.asar` 的可执行文件(如 DSH Desktop.exe)无法按脚本参数拉起,spawn 会启动应用本体并秒退(单实例锁)——一律跳过。

DSH Desktop 上②命中即可用;dev 模式宿主仍可走④复用。插件在运行时只探测现有文件,不会在 DSH 启动时隐式下载。0.4.16 的安装脚本通常提前准备二进制,但脚本批准、网络、`--ignore-scripts` 与下载跳过设置都可能影响结果。缺失时按[准备 Electron 二进制](#准备-electron-二进制)在正确 profile 执行 `npx --no dsh-browser-install-electron`。必要时可把 `ELECTRON_PATH` 指向已核验版本的裸 Electron 二进制,不能指向 `DSH Desktop.exe`。

**Q:截图失败或挂起?**
先核对实际使用的 Electron 版本和 `ELECTRON_PATH`。0.4.16 依赖为 `^44.10.0`;旧覆盖仍可能选中旧内核,安全最低阈值为 `44.9.1`。自托管截图优先走原生 `capturePage`,多视图/窗口未激活时自动兜底到 CDP。

**Q:浏览器窗口不见了?**
窗口标题为 `dsh-browser`(自托管)。若子进程崩溃(或宿主 DSH 重启)会自动重启;崩溃前已打开的会话在**下一次调用时自动重建**——仅页面状态丢失,无需手动 `dsh_browser_reset_session`。`dsh_browser_reset_session` 仍可用于主动重置。

**Q:设置里的 `contentMaxChars` 改了没反应?**
先确认改的是哪一层。优先级从高到低是:**单次调用的 `maxChars`** > **配置里的 `contentMaxChars`** > **按格式的分档默认**(html/json 50 000,txt/markdown 20 000)。`contentMaxChars` 的作用就是给这个部署换一个默认值:不设时才用分档,设了就盖过分档。若改了没反应,通常是那一次调用自己传了 `maxChars`。

**Q:本机 Chrome / Edge 被关掉之后还能继续用吗?**
能。该载体观察进程退出并清掉**已失效的会话映射**,下一次调用会**重新拉起**浏览器并继续工作;重新拉起前会先 kill 旧进程并**最多等 3 秒**它真正退出,且**只认本次启动写下的 `DevToolsActivePort`**(被杀掉的浏览器没机会清理那个文件,照读会连到别的 Chromium 或 `node --inspect` 上)。反过来,页面只是**慢**不会让插件杀掉你的窗口:命令超时只把连接标记为存疑,下一次调用先用 `Browser.getVersion` 探一次再决定是否丢弃,只有 socket 已关闭才重启。

**Q:下载报 CORS 错误?**
`dsh_browser_download` 在页面上下文内 `fetch`,受同源/CORS 约束;跨域文件请先在同源页面内操作,或直接请求用户提供。仅支持 HTTP(S) URL;`savePath` 必须为绝对路径且位于 `downloadDir` 内(默认系统下载目录,自动识别 `Downloads`/`下载`/`下載`),不覆盖已有文件;`dsh_browser_screenshot` 的 `savePath` 受同一套限制。

**Q:如何禁止 agent 乱点?**
`dsh_browser_restrict` 设置白名单(如只允许 `dsh_browser_snapshot`/`dsh_browser_content`);传空列表解除。注意它是防误操作的**软护栏**,模型可自行解除,不是安全边界。

要一个**模型自己解不掉**的限制,用设置页「Agent 能做什么」的三个开关(执行页面脚本 / 下载文件到磁盘 / 写入登录状态):它们写在设置文档里,而没有任何工具能写那个文档,所以模型只能被拒 —— 这与 `dsh_browser_restrict` 的区别不是"谁更强",而是"谁能改"。部署级(对所有人生效)还可以用 `tool-browser` 的 `allowedActions` 配置,见 `cordis.patch.yml` 的注释。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `BROWSER_SESSION_UNKNOWN` | 会话已被关闭/重建(如 `dsh_browser_reset_session` 后仍引用旧会话) | `dsh_browser_session` 查看现状;或 `dsh_browser_reset_session` 重建 |
| 工具超时 | 页面卡死/未渲染完成 | 稍后重试;`dsh_browser_reset` 重置标签 |
| 导航被拒 | 非 HTTP(S) 协议 | 检查 URL;`httpOnly` 配置 |
| 快照为空 | 页面尚未加载 | 等待后重试 `dsh_browser_snapshot` |

## 兼容范围与验证记录

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness(dsh) | `engines.dsh` 声明 `>=0.1.1-rc.2 <0.3.0`;rc.5 已做真实宿主 peer 的 34 工具注册和两个假 provider 调用验证,以及对应 DOM 结构的侧栏回归测试;较早的 `0.2.1-rc.1` 等版本有历史验证记录 |
| Electron | 0.4.16 依赖为 `^44.10.0`,锁文件 `44.10.0`;真实 `44.10.0` 已通过隔离自托管烟测,详见[变更记录](../CHANGELOG.md#发布准备验证2026-10-31);安全最低阈值 `44.9.1` |
| Node.js | `22.20.0` |
| 本机 Chrome / Edge(可选载体) | `154.0.8037.58` / `154.0.4258.37` |
| 操作系统 | Windows 10 (10.0.26200) |

> 本表区分依赖声明与验证证据,不表示每种宿主/载体组合都做过端到端测试。系统浏览器的查找已适配 Linux 与 macOS(先查 `PATH`,再查各平台的惯例安装位置,均可用 `DSH_BROWSER_CHROME_PATH` / `DSH_BROWSER_EDGE_PATH` 覆盖),但这两个平台上的**端到端链路尚未实测**。

> **宿主兼容性可以随时复验**:`node scripts/verify-host-compat.mjs` 会用某个 profile 里**真实安装**的 `@deepseek-ai/*` 包组装一个宿主,加载本插件的编译产物并真调两个工具。详见[开发](development.md)。

## 更新方式(两端不同)

插件在两种宿主里各有一份安装,更新路径也不同 —— **更新其中一端不会连带更新另一端**。

### 升级到 0.4.16

0.4.16 正在本地准备,尚未发布到 npm。它集中修复并发选页、下载/截图覆盖风险、bridge 边界、设置门控、载体切换与桌面 rc.5 侧栏适配。**所有现有用户都建议在发布后更新**,包括只安装本插件的用户。更新时按下列顺序处理:

1. 先保存正在进行的任务并关闭相关浏览器。备份实际 `$DSH_HOME` 下的对应 profile 和 `dsh-builtin-browser-host/`(设置、历史与浏览器登录数据)。若使用侧栏 bridge,还要关闭 DSH Desktop 并备份其安装目录的 `resources/`。
2. 按下节对实际使用的 `web` 或 `desktop` profile **先移除插件、再安装目标版本**。版本发布后目标版本填 `0.4.16`;测试本地候选包时,`add` 后传入已提供的 `.tgz` 绝对路径。按宿主提示批准构建脚本;脚本被跳过或二进制缺失时按上方说明手动准备。这里移除的是 profile 中的插件,不涉及卸载 DSH Desktop。
3. 检查启动 DSH 的环境中的 `ELECTRON_PATH`。它是最高优先级的显式覆盖,**旧路径仍存在就会盖过新版插件依赖**。需要自托管时,清除不再使用的覆盖或改指向已核验的裸 Electron `44.10.0` 等 `44.x` 二进制(安全最低阈值为 `44.9.1`);环境变量改变后重启 DSH 进程。
4. 使用侧栏时,从**新版插件目录**运行下节的 bridge 安装脚本并重启桌面端。插件更新不会更新外壳或外壳内 bridge;外壳升级也不会更新 profile 中的插件。外壳缺少可驱动的 `<webview>` 时仍回退自托管。
5. 重启对应宿主后,让 agent 打开测试页、列出本任务标签并保存一张截图,确认载体、页面归属与保存路径符合预期。原有设置与数据通常保留;先保留备份,再继续正式任务。

本次未扩展服务器上的内置 Electron 无头能力。`browser.headless` 与 `cookies.persist` 仍只控制本机 Chrome / Edge,详见[已知限制](limitations.md)。

### 先移除,再安装

**DSH 0.2.1-alpha.2 起,对已经装着的包再执行一次安装会直接失败**,报 `already-installed`,并且在跑 pnpm 之前就失败、不改任何 profile 文件(官方迁移指南:`docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/`)。这条在启用 HMR 的 profile 上生效,而自带 profile 都启用 HMR。

所以更新一个**已安装**的插件是两步:

```bash
dsh plugin --profile web remove dsh-builtin-browser
dsh plugin --profile web add dsh-builtin-browser@<目标版本>
```

移除会停掉该 bundle 的插件并清掉它的包映射,新版本随即重新映射。更新完成后重启对应宿主,确保客户端、bridge 与浏览器子进程使用同一版代码。

若宿主的插件管理页提供适用于该插件的更新按钮,也可使用它;已安装的包不能直接重复 `add`。

## 桌面端细节

**桌面端(DSH Desktop)**

- 插件是桌面端 profile 里的依赖(profile 目录通常是 `$DSH_HOME/profiles/desktop`)。更新它 = 把该 profile 里的依赖更新到新版本,然后**重启 DSH Desktop**,客户端设置栏与工具才会换成新代码。
- **桌面端还多一步,而 Web 端没有**:让插件驱动侧栏的那条 bridge 装在**桌面端自己的安装目录**里(`resources/app/`),插件更新**不会**带上它。桌面端升级会替换该目录、bridge 随之消失,所以请重跑一次:
  ```bash
  node desktop-bridge/install.mjs "<DSH Desktop 安装目录>"
  ```
  从新版插件目录运行,先关闭桌面端并备份 `resources/`。插件升级后也要重跑以刷新 bridge 模块。安装脚本会维护 `.before-bridge` 备份;保留这些文件。若需要回滚,使用新版脚本的 `--revert`,遇到已有 `app.asar` 或无法确认补丁归属的拒绝应停止,保留当前应用与备份。不要手动删除当前 `app.asar` 来强行回滚。
  bridge 不在时插件自动退回自托管(多出一个独立窗口);载体差异见[已知限制](limitations.md)。
- 使用侧栏时浏览器内核来自桌面外壳,**插件更新不会升级这份内核**;自托管回退使用插件依赖的 Electron。也可以在设置里改用自己安装的 Chrome / Edge。
- **升级桌面端本身不会带上插件**,按上面的方法单独更新它。

## Web 端细节

**Web 端(`dsh web`)**

- 插件是 web profile 里的依赖(`$DSH_HOME/profiles/web`),更新后**重启 `dsh web`** 生效。
- Web 端**没有侧栏、也没有 bridge**:共享浏览器由插件自托管拉起。Electron 包自身使用懒下载,0.4.16 由本插件的安装脚本提前准备二进制;是否执行受宿主脚本批准与跳过设置控制。缺失时在该 profile 目录执行 `npx --no dsh-browser-install-electron`,见[准备 Electron 二进制](#准备-electron-二进制)。
- 同样可以在设置里改用本机 Chrome / Edge —— 这是两端**行为一致**的选项。
- 更新方式与首次安装它时一致(按 npm 包名 `dsh-builtin-browser`、按 GitHub 仓库 `wqty123/dsh-browser`,或本地目录),但**已安装时先按上面的两步移除再装**。

**两端一致的体验**

- 两端提供相同的工具集、浏览器设置页和浏览历史功能。`cookies.persist` 与 `browser.headless` 仅控制设置中选择的本机 Chrome / Edge,修改后重新选择载体或重启 DSH 生效;内置 Electron 与官方侧栏的登录态由各自载体保存。
- 插件的数据目录独立于包安装目录:浏览历史与设置都在 `$DSH_HOME/dsh-builtin-browser-host/`(`history.jsonl`、`settings.json`),本机浏览器的登录状态在其中的 `<chrome|edge>-profile`。更新前仍应备份;侧栏登录态保存在桌面外壳自己的数据目录,需单独保留。
- 升级后如果历史记录不符合预期,先去「设置 → 浏览器」确认这些开关:历史默认**开**、侧栏自动展开默认**开**、会话结束时自动关闭浏览器默认**关**、载体默认**内置**。

## 从 0.4.7 升级到 0.4.8

> 以下为历史改名说明,不代表当前版本的升级建议。当前请参照[升级到 0.4.16](#升级到-0416)。

**这是一个改名版本:34 个工具从 `browser_*` 移入 `dsh_browser_*`,功能一字未改。**

| | |
| --- | --- |
| **只装这一个浏览器插件** | 当时的 0.4.8 仅改工具名;当前版本另有安全与稳定性修复,请按上方说明升级。 |
| **还装了别的浏览器插件**(尤其腾讯 BrowserSkill) | **建议更新**,否则对方那套工具注册不上。 |

改名原因见 [README 的工具名空间一节](../README.md#工具名空间)。更新后 `browser_open` → `dsh_browser_open`(其余同理),并**重启 DSH** 使其生效。

> **0.4.8 起,一个名字被占不再毁掉整套工具。** 此前 34 个工具是顺序直接注册的,一个重名抛错会中断余下的注册,表现成"插件装了但没反应"。现在每个工具独立注册,碰撞只产生一条点名报错的日志(`could not register dsh_browser_xxx`),其余工具照常可用。
