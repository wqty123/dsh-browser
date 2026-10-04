# 用户指南

## 环境要求

- DeepSeek Harness(dsh),已安装对应 profile(`web` / `desktop` 等)
- **Electron 运行时**(必装依赖,随插件自动安装):
  - **DSH Desktop**:打包宿主 exe(`DSH Desktop.exe`)**不复用**——打包应用无法按脚本参数拉起,误用会秒退(issue #6);直接使用随包 electron,开发模式的**裸** Electron 宿主仍可复用;
  - **纯 `dsh web` 自托管**:直接使用随插件安装的 electron 包(建议 ≥ 40,33.x 存在截图合成器缺陷;44+ 二进制首次缺失时按报错提示先 `npx install-electron`,需网络)。

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
| `tool-browser` | `dsh-builtin-browser/tool-browser` | `browser_*` 模型侧工具 |

> 没有桌面外壳时插件**自托管**:自己拉起一个标题为 `dsh-browser` 的 Electron 窗口,`browser_*` 工具照常可用。

## 配置

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 可选 | 宿主提供的 `ElectronBrowserViewHost`(通常 `!!js ctx.get('electronViewHost')`)。**不传时插件自己选载体**:桌面端驱动官方侧栏、否则自托管;设置里显式选择的 Chrome/Edge 优先于两者 |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;`file:`/`data:` 等拒绝 |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数 |
| `browser-electron` | `contentMaxChars` | 数字 | 未设置(按格式分档) | 内容抓取的字符上限。**不设**时按格式取分档默认(html 50 000、json 50 000、txt 20 000、markdown 20 000);**设了**就是操作者的值,覆盖分档默认。单次调用的 `maxChars` 优先级最高 |
| `browser-electron` | `downloadDir` | 字符串 | 系统下载目录(自动识别 `Downloads`/`下载`/`下載`,或 `XDG_DOWNLOAD_DIR`) | 限定 `browser_download` 与 `browser_screenshot` 保存路径必须位于该目录内且不覆盖已有文件;默认收敛到系统下载目录,可改沙箱目录 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具 |
| `tool-browser` | `allowedActions` | 字符串数组 | 不限制 | **部署级**动作白名单,对该部署里的每个任务生效(单个任务仍可用 `browser_restrict` 再收窄);`READ_ONLY_TOOLS` 与 `browser_restrict` 无论列表怎么写都不拦。`cordis.patch.yml` 默认给的是空 `config: {}`(等于不限制) |

## 快速上手(给 agent 的提示词示例)

```
1. browser_open 打开 https://example.com
2. 慢站点先 browser_wait(url=…) 等页面就绪,再 browser_snapshot 查看可交互元素
3. 需要填表时用 browser_fill(按 name/label/placeholder 匹配,一次填多个字段)
4. 需要截图确认时用 browser_screenshot(可 savePath 存文件,大页面用 maxWidth 缩小)
5. 需要滚动/回退/按键时用 browser_scroll / browser_back / browser_forward / browser_key
6. 遇到验证码(browser_challenge 或快照标注 CHALLENGE)时,停下请用户处理
7. 每次操作后告知用户你在页面上做了什么
```

## 操作纪律

**先确认视觉策略。** 设置里的 `vision.strategy` 决定坐标点击能不能用,**而且只决定这一件事**:

- **`auto`(默认)**:坐标与语义都允许,适合能读图的模型。
- **`nonVisual`**:**坐标点击被明确拒绝**,报 `BROWSER_NON_VISUAL_COORDINATES`,错误信息直接给出改法 —— 传语义 target,如 `target { by: "text", value: "Sign in" }`。**这是配置,不是故障,不要重试同一次坐标点击。**

**两种策略下 DOM 查询、无障碍树、文本提取与结构化抓取完全一致** —— 所以下面这些纪律对**所有模型**都成立,不是因为谁看不了图。

**定位:先用语义,再考虑坐标**

- **`browser_a11y` 是理解页面的首选**,它给出每个交互节点的**角色**(button/textbox/…)与**可访问名称**,比读 DOM 更接近"这页面上有什么";`browser_snapshot` 给出可点击元素的**引用与坐标**。
- **两者都带 `selector`**:无 id 且无 name 时是空串。**有 `selector` 就优先用它**,它比坐标稳定 —— 页面滚动、布局变化都不会让它失效,而坐标会。
- **优先用 DOM 语义而非坐标**:表单提交优先 `form.requestSubmit()`;点击优先 `element.click()`;坐标点击是最后手段。
- **`browser_click` 的 `target`(css/text)本质上就是语义定位**,能用它就别自己算坐标 —— 它会把元素滚进视野并在中心点击,坐标抖动、像素比、iframe 偏移都由它处理。
- **选中正确的元素**:页面常有隐藏副本(如移动端按钮),用 `browser_execute` 过滤可见元素(`getBoundingClientRect()` 宽高 > 0、`getComputedStyle` 非 `display:none`),再取坐标。
- **取坐标后立即点击**:中间不要插入其他操作(填表、滚动会移动元素,旧坐标立即失效)。
- **点击前验证命中**:`document.elementFromPoint(x, y)` 确认该坐标确实是目标元素,再执行真实点击。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

**截图与内容:先问"我要的是判断还是像素"**

- **能用文本就用文本。** `browser_snapshot` / `browser_a11y` / `browser_content` 给出同一页面的文本表示;**没有图像输入能力的模型看截图什么也得不到**,只会花钱。截图留给布局、图表、设计核对这类**必须看像素**的事。
- **`browser_screenshot` 带 `maxWidth`/`maxHeight` 时,结果里会返回 `width`/`height`**(实际像素尺寸)。需要控制成本时用它确认降采样生效了,而不是自己解码 data URL。
- **`browser_content` 的 `maxChars` 是按格式分档的**(html/json 默认 5 万,其余 2 万),单次传 `maxChars` 优先于设置里的 `contentMaxChars`。

**动作开关:三个门是操作者(人)的,不是你的**

设置页里的**执行页面脚本**、**下载文件到磁盘**、**写入登录态** 由人控制,**任何 `browser_*` 工具都改不了它们**。关掉时对应调用会明确报错,一眼能认出:

| 谁被关 | 报的错误码 | 哪些工具会遇到 |
| --- | --- | --- |
| 执行页面脚本 | `BROWSER_EXECUTE_DISABLED` | `browser_execute`、以及需要页内脚本的工具 |
| 下载文件到磁盘 | `BROWSER_DOWNLOAD_DISABLED` | `browser_download` |
| 写入登录态 | `BROWSER_AUTH_WRITE_DISABLED` | `browser_auth` 的 `restore` |
| 读取 cookie | `BROWSER_AUTH_DISABLED` | `browser_auth` 的 `flush` |

**看到这些码不要重试、不要绕路** —— **它是人的决定,不是可以克服的故障**,直接告诉人"需要他在设置里打开"。

另外几个容易认错来源的码:`BROWSER_DOWNLOAD_BLOCKED` / `BROWSER_SCREENSHOT_BLOCKED` 是**保存路径被沙箱拒绝**(不是开关问题,换路径而不是找开关);`BROWSER_DOWNLOAD_UNSUPPORTED` 是**该载体没有这个能力**(比如非自托管浏览器)。

`browser_restrict` **不一样** —— 那是**你自己**设的临时白名单,你有权设也有权解除;它不该被用来绕过上面三个门。

**失败怎么读**

- **`CDP error: ...` 是浏览器答了但拒绝**(比如元素已经不在)—— 多半是页面变了,重新快照再试,不要盲目重复同一动作。
- **超时 / 连接类错误**才是浏览器可能有问题;这类错误会触发一次自动探测,通常下一条命令就能恢复。
- **`BROWSER_SESSION_UNKNOWN`** 说明会话没了(浏览器被替换过);`browser_reset_session` 重建本任务的会话。
- **同一个动作连续失败两次就换策略**:换 `selector`、换语义定位、或者用 `browser_snapshot` 重新看页面 —— **不要第三次用同样的坐标**。

**`browser_history` 与动作集**

- `browser_history` **默认只给 20 条**,要更多自己传 `limit`。
- **可重放的动作有六种**:`navigate` / `click` / `type` / `scroll` / `key` / `execute`。不是每种历史记录都能 `browser_replay`,遇到不可重放的会明确报错。

## 多任务并行

每个 DSH 会话(任务)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰:

- `browser_session` 查看本任务的会话与标签;
- `browser_reset_session` 关闭并重建本任务的会话(崩溃或卡死后用它恢复)。

登录态(cookie)为所有任务共享;可用 `browser_auth` 导出/恢复,重启后不丢。注意 **`flush` 只导出当前页所属站点的 cookie**(按本会话所在页面的 URL 收敛),页面 URL 未知时**直接拒绝**而不是扩大范围去读整台机器的 cookie 罐;`restore` 会向任意域写 cookie,所以 `browser_auth` **同样受 `browser_restrict` 白名单约束**,不属于只读豁免。

## FAQ

**Q:纯 `dsh web` 能用吗?**
能。插件自托管:自己拉起 Electron 窗口,无需桌面外壳。

**Q:找不到 Electron?**
插件按顺序自动定位:① `ELECTRON_PATH` 环境变量(显式覆盖,优先于一切自动发现)→ ② 随插件安装的 electron 包(纯文件系统探测,不触发 44+ 懒下载)→ ③ DSH 锚点(profile / 全局 prefix 中单独安装的 electron)中版本最新者 → ④ 当前进程就是**裸** Electron(dev 模式)时复用宿主二进制 → ⑤ 进程祖先树中的裸 Electron 二进制。**打包应用不参与复用**:旁有 `resources/app.asar` 的可执行文件(如 DSH Desktop.exe)无法按脚本参数拉起,spawn 会启动应用本体并秒退(单实例锁)——一律跳过。

DSH Desktop 上②命中即可用(0.1.18+ 插件自带 electron 包;44+ 二进制缺失时先 `npx install-electron`,需网络);dev 模式宿主走④复用,亦零安装。全部落空时,报错会给出指引:electron 已随插件安装,44+ 二进制缺失时先 `npx install-electron`(需网络);必要时可设置 `ELECTRON_PATH`。

**Q:截图失败或挂起?**
确保 Electron ≥ 40(33.x 有合成器缺陷)。自托管截图优先走原生 `capturePage`,多视图/窗口未激活时自动兜底到 CDP。

**Q:浏览器窗口不见了?**
窗口标题为 `dsh-browser`(自托管)。若子进程崩溃(或宿主 DSH 重启)会自动重启;崩溃前已打开的会话在**下一次调用时自动重建**——仅页面状态丢失,无需手动 `browser_reset_session`。`browser_reset_session` 仍可用于主动重置。

**Q:设置里的 `contentMaxChars` 改了没反应?**
先确认改的是哪一层。优先级从高到低是:**单次调用的 `maxChars`** > **配置里的 `contentMaxChars`** > **按格式的分档默认**(html/json 50 000,txt/markdown 20 000)。`contentMaxChars` 的作用就是给这个部署换一个默认值:不设时才用分档,设了就盖过分档。若改了没反应,通常是那一次调用自己传了 `maxChars`。

**Q:本机 Chrome / Edge 被关掉之后还能继续用吗?**
能。该载体观察进程退出并清掉**已失效的会话映射**,下一次调用会**重新拉起**浏览器并继续工作;重新拉起前会先 kill 旧进程并**最多等 3 秒**它真正退出,且**只认本次启动写下的 `DevToolsActivePort`**(被杀掉的浏览器没机会清理那个文件,照读会连到别的 Chromium 或 `node --inspect` 上)。反过来,页面只是**慢**不会让插件杀掉你的窗口:命令超时只把连接标记为存疑,下一次调用先用 `Browser.getVersion` 探一次再决定是否丢弃,只有 socket 已关闭才重启。

**Q:下载报 CORS 错误?**
`browser_download` 在页面上下文内 `fetch`,受同源/CORS 约束;跨域文件请先在同源页面内操作,或直接请求用户提供。仅支持 HTTP(S) URL;`savePath` 必须为绝对路径且位于 `downloadDir` 内(默认系统下载目录,自动识别 `Downloads`/`下载`/`下載`),不覆盖已有文件;`browser_screenshot` 的 `savePath` 受同一套限制。

**Q:如何禁止 agent 乱点?**
`browser_restrict` 设置白名单(如只允许 `browser_snapshot`/`browser_content`);传空列表解除。注意它是防误操作的**软护栏**,模型可自行解除,不是安全边界。

要一个**模型自己解不掉**的限制,用设置页「Agent 能做什么」的三个开关(执行页面脚本 / 下载文件到磁盘 / 写入登录状态):它们写在设置文档里,而没有任何工具能写那个文档,所以模型只能被拒 —— 这与 `browser_restrict` 的区别不是"谁更强",而是"谁能改"。部署级(对所有人生效)还可以用 `tool-browser` 的 `allowedActions` 配置,见 `cordis.patch.yml` 的注释。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `BROWSER_SESSION_UNKNOWN` | 会话已被关闭/重建(如 `browser_reset_session` 后仍引用旧会话) | `browser_session` 查看现状;或 `browser_reset_session` 重建 |
| 工具超时 | 页面卡死/未渲染完成 | 稍后重试;`browser_reset` 重置标签 |
| 导航被拒 | 非 HTTP(S) 协议 | 检查 URL;`httpOnly` 配置 |
| 快照为空 | 页面尚未加载 | 等待后重试 `browser_snapshot` |
