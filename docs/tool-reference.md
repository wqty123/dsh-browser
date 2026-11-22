# 工具参考

`dsh_browser_list_tabs` and `dsh_browser_session` return versioned opaque handles.
Pass the complete tab `id` unchanged to `dsh_browser_switch_tab` or
`dsh_browser_close_tab`. Handles include the calling owner and browser session;
raw provider ids (`tab:…`, `page:…`), foreign-owner handles and handles from a
closed/replaced session are refused. List again after a session reset. Handles
identify a target, not authorization. The same handles travel through the runtime,
provider and protocol-4 desktop bridge. The bridge binds them to live native guests
at discovery/adoption and refuses released or replaced bindings. Legacy bridges
must be restarted/upgraded; raw owner/guest/view-id RPC requests are not accepted.

以下为浏览器工具目录；默认安装不会一次展示全部工具。守卫列的 ✅ 表示受 `dsh_browser_restrict` 白名单约束；– 表示该工具不受该白名单限制，**不代表跳过宿主权限**。

## 工具如何加载

| 配置 / 模式 | 行为 |
| --- | --- |
| `surface: core`（默认） | 常用工具立即可用；`dsh_browser_load_tools` 按需扩展列表。标准 DSH 模式也提供 `dsh_browser_code`。 |
| `surface: code` | 仅暴露 `dsh_browser_code` 和接管工具；代码工具在 PTC 下也保留。 |
| `surface: tools` | 一次注册全部单动作工具，不使用插件的代码工具。 |
| DSH PTC + 默认 `core` | 使用宿主的 `run_code` 批处理，插件不重复提供 `dsh_browser_code`。 |

`dsh_browser_load_tools({ groups: ['debug'] })` 返回本次加载的 `loaded` 和所请求组中已经可用的 `available`。组名：`forms`（表单及输入）、`navigation`（前进、刷新、历史及下载）、`debug`（观测、断言及排查）、`session`（会话、权限及快捷方式）、`more`（其它）。已加载工具不撤销。

## JavaScript 批处理

`dsh_browser_code` 接收 `{ code, timeoutMs? }`（默认 120 秒，最长 600 秒），返回 `{ output, ok, calls, images }`。每个任务有自己的 REPL；顶层变量和函数可供后续单元使用，最后一个表达式可输出。动作按调用顺序执行，独立读取可以用 `Promise.all`。已经 `print()` 的内容在执行中取消或到时仍可返回；取消不会回滚页面动作，重试前先核对结果。

以下代码放进 `code`：

```js
await tools.dsh_browser_open({ url: 'https://example.com' })
const [content, match] = await Promise.all([
  tools.dsh_browser_content({ format: 'markdown', maxChars: 400 }),
  tools.dsh_browser_find({ text: 'Example Domain' }),
])
print({ content, match })
```

`tools.dsh_browser_<name>(args)` 返回该工具的 JSON 结果，失败抛出带工具名的 `ToolCallError`。也可用 `await help()` 查看 `goto_url`、`js`、`scroll(dy)` / `scroll(x, y, dy)` 等快捷函数。同一权限、接管阻断和会话约束适用；代码工具不会替你取得 Web guest 的 CDP 能力。

## 请求人工接管

`dsh_browser_request_takeover({ reason, instructions? })` 把当前对话的可见侧栏标签交给用户，也可用于手动打开的 Web 隔离页。等待 `outcome`；只有 `done` 表示用户确认完成，仍须核对返回的 `page`。跳过或取消不代表成功。需要登录、验证码、2FA 或付款确认时走此入口。

## 固定步骤、观测与断言

页面探针收集控制台、网络和页面脚本弹窗记录，拖拽与悬停通过浏览器的 CDP 输入通道执行。`fetch` 和 `XHR` 记录包含状态码，资源计时记录的状态码为 0。

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_do` | `steps`(必填,最多 40), `timeoutMs?`, `autoDismiss?` | `{ ok, completed, total, stoppedAt?, reason?, log[] }` | ✅ | **一次调用跑一串步骤**,失败即停并指出第几步。步骤键(每步恰好一个):`open{url}` `tap{target}` `field{target,text}` `type{text}` `key{key}` `scroll{deltaY}` `sleep_ms{ms}` `wait_text{text}` `wait_gone{text}` `wait_url{url}` `wait_idle{}` `eval{script}` `check{selector|text|url|js}`。等待基于条件而不是睡眠;`tap` 的目标被 cookie 横幅/弹窗盖住时先把它关掉 |
| `dsh_browser_console` | `limit?`(默认 20,上限 100), `filter?`, `clear?` | `{ entries[] }` | – 豁免 | 页面控制台最新若干行(含 level);先 `clear:true` 可只看之后发生的事 |
| `dsh_browser_network` | `limit?`, `filter?`, `onlyFailures?`, `clear?` | `{ entries[] }` | – 豁免 | fetch/XHR/资源计时行:方法、状态、类型、地址、耗时;`onlyFailures` 保留 0 与 >=400 |
| `dsh_browser_wait_for_response` | `urlContains`(必填), `status?`, `timeoutMs?` | `{ matched, reason, entry? }` | – 豁免 | 等**本次调用之后**到达的响应(可按状态过滤);回答"提交到底有没有到服务器",截图答不了这个 |
| `dsh_browser_assert` | `selector?` `text?` `url?` `js?`(至少一个) | `{ pass, checks[] }` | – 豁免 | 一次断言多件事,逐条给证据;"点到了"和"表单接受了"是两回事,重试前应先断言 |
| `dsh_browser_dialog` | `policy?`(native/accept/dismiss), `limit?` | `{ policy, dialogs[] }` | ✅ | 默认保留网页原生弹窗；显式选择 accept 或 dismiss 后记录并自动应答 alert/confirm/prompt，选择 native 恢复原生处理 |
| `dsh_browser_drag` | `fromX` `fromY` `toX` `toY`(必填), `steps?` | `{ ok, reason }` | ✅ | 通过 CDP 按下鼠标、按住移动并释放，操作滑块、排序列表、HTML5 拖放和画布。坐标使用当前视口的 CSS 像素，操作后可用 `assert` 核对控件值、顺序或页面结果 |
| `dsh_browser_hover` | `target`(必填), `settleMs?` | `{ hovered, at }` | ✅ | 将浏览器指针移到目标中心，触发 CSS 悬停样式及鼠标事件。目标支持 `{by, value}`，可按 css、text 或 xpath 定位 |
| `dsh_browser_doctor` | – | `{ report }` | – 豁免 | 自检:URL、进行中的请求数、静默时长、探针已装、三类缓冲各多少条、本任务被限制掉哪些工具 |
| `dsh_browser_help` | `topic?` | `{ text }` | – 豁免 | 主题索引(locate/wait/batch/dialogs/network/verify/recovery/limits)或单篇正文 |

`tap` 的 `target` 与 `click` 相同:一个字符串按可见文本匹配,或 `{by, value}`(`css`/`text`/`xpath`)。

## 页面与导航

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_open` | `url`(必填), `newTab?` | 快照(url/title/elements/truncated/challenge) | ✅ | 打开 URL,返回带编号元素的快照;`newTab: true` 在新标签打开 |
| `dsh_browser_wait` | `timeoutMs?`, `url?`, `selector?` | `{ ready, reason }` | – | 等待页面加载完成(可选期望 URL / CSS 选择器);未就绪不抛错,返回原因 |
| `dsh_browser_snapshot` | – | 快照 | – | 交互元素(输入框/按钮/链接)编号清单,供定位与点击;穿透同源 iframe 与 Shadow DOM,iframe 内元素标注 `frame`。元素有 `id` 或 `name` 时,每行末尾附**可直接引用**的 `{#id}` / `{[name=x]}`(推导不出来时该段不出现),可原样作为 `dsh_browser_click`/`dsh_browser_type` 的 `target {by:"css", value:"…"}` |
| `dsh_browser_a11y` | `includeHidden?`, `maxNodes?`(10-5000,**默认 150**), `coords?` | `{ url, title?, count, nodes[], truncated }` | – | 无障碍树:每个交互节点的 `role`/`name`/`value`/`states`/`depth`/`tag`/`selector`,优先 Chrome `computedRole`/`computedName`,穿透同源 iframe 与 Shadow DOM。**默认不返回坐标**(需要像素落点时传 `coords: true`;要按文本驱动目标,用节点的 `name` 配 `dsh_browser_click` 的 `target {by:"text"}`)。`states` **省略字面量 `enabled`（`unchecked`、`collapsed` 等仍会打印）** —— 没有 `states=` 就是 enabled;缩进为一层一个空格 |
| `dsh_browser_content` | `format`(html/markdown/txt/json,必填), `selector?`, `maxChars?`, `timeoutMs?` | `{ content, truncated }` | – | 抓取页面内容;`selector` 限定区域。**字符上限按格式**(默认):`html`/`json` **50 000**,`txt`/`markdown` **20 000**,单次调用用 `maxChars` 覆盖;被截断时结果末尾提示如何收窄。`json` 返回 `{"html": "<元素 outerHTML>", "tag": "<标签名>"}` —— 不是空对象(DOM 节点自身没有可枚举属性,`JSON.stringify` 一个元素只会得到 `{}`) |
| `dsh_browser_challenge` | – | `{ blocked, kind?, reason?, hint? }` | – | 检测人机验证(CAPTCHA/Cloudflare/reCAPTCHA/hCaptcha/Turnstile);阻塞时请用户处理 |

## 页面操作

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_execute` | `script`(必填), `args?` | `{ ok, value? / exception? }` | ✅ | 在页面执行 JS;脚本以 `return` 开头或作为表达式;`args` 以 `arguments[0..n]` 传入。**返回值上限 50 000 字符**,超出时结果里写明"截断于 50 000 / 实际 N 字符"(要完整内容请让表达式返回更小的值)。受设置「Agent 能做什么 → 允许在页面里执行脚本」门控,关闭后一律被拒(`BROWSER_EXECUTE_DISABLED`),且没有任何工具能把它打开 |
| `dsh_browser_click` | `target?`(css/text/xpath), `x?`, `y?`(target 与坐标二选一) | `{ clicked }` | ✅ | 语义目标点击:按 `target` 定位、滚动到视口中央再点中心;或视口坐标点击(配合截图做视觉定位) |
| `dsh_browser_click_sequence` | `points`(必填,`{x,y}[]`), `intervalMs?`(默认 40) | `{ clicked, failedAt?, error? }` | ✅ | 一次调用打一串**视口坐标**点击:只 `present()` 一次,每点走 `mouseMoved`/`mousePressed`/`mouseReleased`;点间默认 40 ms(低于此值页面会把两次按下读成双击或丢弃)。**首点失败即停**并回报 `failedAt`。用于 canvas 页面——它们不采信脚本派发的 `MouseEvent`/`PointerEvent`/`element.click()`,只认 `isTrusted` 的真实输入(实测:sudoku.com 一盘 84 点一次打完) |
| `dsh_browser_type` | `text`(必填), `target?` | `{ typed }` | ✅ | 输入文本;传 `target` 先聚焦该元素(CDP `Input.insertText`) |
| `dsh_browser_key` | `key`(必填,枚举) | `{ pressed }` | ✅ | 按命名按键:Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space |
| `dsh_browser_scroll` | `deltaX?`, `deltaY?`, `selector?`, `toTop?`, `toBottom?` | `{ scrolled }` | ✅ | 滚动页面:像素增量 / 选择器定位 / 顶部底部 |
| `dsh_browser_back` | – | `{ back }` | ✅ | 页面历史后退一步(无前项时为空操作) |
| `dsh_browser_forward` | – | `{ forward }` | ✅ | 页面历史前进一步(无后项时为空操作) |
| `dsh_browser_refresh` | – | `{ refreshed }` | ✅ | 刷新当前页(等价浏览器刷新按钮) |
| `dsh_browser_fill` | `fields`(必填,数组), `submit?` | `{ fields[], submitted }` | ✅ | 批量填表;字段按 `selector`/`name`/`label`/`placeholder` 匹配,值支持字符串/数字/布尔;单个字段失败不影响其余;`submit: true` 提交表单 |
| `dsh_browser_set_value` | `target`(必填), `value`(必填) | `{ method, value }` | ✅ | 单个控件设值(按 css/text/xpath 定位);原生 setter + input/change,React 受控输入可用;select 按值/文本 |
| `dsh_browser_check` | `target`(必填), `checked?` | `{ checked }` | ✅ | 勾选/取消勾选 checkbox 或 radio(按 target 定位) |
| `dsh_browser_select` | `target`(必填), `optionValue?`/`optionText?`/`optionIndex?`(三选一) | `{ value, text }` | ✅ | 选中 `<select>` 的某个选项(按 target 定位) |
| `dsh_browser_clear` | `target`(必填) | `{ cleared }` | ✅ | 清空输入/文本域/contenteditable,或取消勾选 checkbox/radio |
| `dsh_browser_get_value` | `target`(必填) | `{ value?, checked?, selectedText? }` | – 豁免 | 读取元素当前值,用于操作后验证 |
| `dsh_browser_scrape` | `item`(必填), `fields`(必填,映射), `timeoutMs?` | `{ count, items[] }` | – 豁免 | 结构化提取:容器选择器 + 字段映射(如 `{"title": "h3", "url": "a@href"}`);静态 CSS 查询、不执行任意代码、CSP 安全;等待 item 出现(默认 5s)。**结果是最紧凑的 JSON**(不缩进),条目数在最前面 |

## 网页引用

在网页中选中文字、图片或表格后，由 `dsh_browser_reference_capture` 保存为不可变快照；之后用 `reference_reveal` 回到原页面并高亮。引用 id 可写成 `dsh-browser-ref:<id>`（或 `dsh-browser-ref:<id>/<partId>`）供回复正文引用。设置面板的「网页引用」列出最近 10 条并提供「定位」。

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_reference_capture` | `allowPartial?`, `tableSelector?`, `excerptText?` | `{ ok, referenceId?, pageUrl?, title?, parts[], failures[] }` | – 豁免 | 采集当前选区：文字保存原文与前后文（Text Quote），图片保存实际字节（原图优先，取不到时页面内栅格化），表格保存行列/合并/表头/部分选择等结构。默认整组失败即拒绝（`failures` 说明哪个片段失败）；`allowPartial: true` 才提交成功片段。无选区时可传 `excerptText` 登记助手自己读到的原文（出现两次视为歧义并拒绝）。重复采集同一区域会得到新引用，旧快照不变 |
| `dsh_browser_reference_reveal` | `referenceId`（必填，可带前缀）, `partId?` | `{ status, pageUrl, currentUrl?, note?, parts[] }` | – 豁免 | 回到引用：核对当前页面 URL，按 Text Quote（原文 + 前后文，空白折叠兜底）定位并高亮文字，或按来源/alt/表头定位图片与表格。`status`：`revealed` / `ambiguous`（同分候选，不猜）/ `missing` / `page-mismatch`（先打开保存的 pageUrl）/ `session-unavailable`（捕获它的浏览器已关闭）。不带 `partId` 时定位整组的第一个片段 |
| `dsh_browser_reference_list` | `limit?`（默认 20，上限 100） | `{ references[] }` | – 豁免 | 本任务保存的引用，最新在前：id、页面、时间、每个片段一行预览 |

引用数据保存在 `$DSH_HOME/dsh-builtin-browser-host/references.jsonl`，图片字节按内容哈希保存在同目录的 `reference-assets/` 下（`<sha256>.bin` 与 `<sha256>.json`）。交付记录（草稿交接）写在同目录的 `reference-deliveries.jsonl`。

**引用如何进入对话**：`BrowserReferenceDraftAdapter` 已注册，`/reference/insert` 把引用冻结进持久交付队列，不再返回 `draft-adapter-unavailable`；真正的草稿写入由宿主 `ui-browser-reference` 客户端完成（轮询 → 保序追加 → 资产绑定 → ACK）。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `reference/list` `reference/get` | GET | 列表（摘要，最新在前）与单条详情（完整快照） |
| `reference/capture` `reference/reveal` `reference/insert` | POST | 采集、定位、送入草稿队列；写操作要求同源 + 直连回环 |
| `reference/export` `reference/import` | GET / POST | 导出 jsonl／markdown／zip／markdown-zip；导入只接受本插件 `format=zip` 包 |
| `reference/deliveries?sessionId=&since=` | GET | 客户端按自己的会话轮询；**缺少 `sessionId` 一律 400**，不会返回其它会话的记录 |
| `reference/delivery/ack` `reference/delivery/remove` | POST | ACK 只在草稿修订与全部图片资产绑定后成立；remove 写 tombstone，迟到重试不会复活 |
| `reference/asset?key=&encoding=` | GET | 图片真实字节（`base64` 形态返回 JSON），供卡片缩略图与模型图片块使用 |
| `reference/status` | GET | 诊断：本进程认哪个会话、侧栏扫描到几页、上次失败原因 |

这里的侧栏选区交互与浏览器扩展的连接设置是两回事；显式选择外部浏览器时，实际工具能力取决于载体。

## 起始页快捷方式

起始页的共享快捷方式写在 `browser-startpage` 设置分节里，侧栏 UI 与该接口读写同一份数据。人工可在空标签页的起始页「添加」；没有侧栏的调用方（agent、脚本）用下面这个工具或同名 HTTP 接口。

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_shortcuts` | `action`（必填：`list`/`add`/`remove`）, `title?`, `url?`, `id?` | `{ shortcuts[], changed }` | – 豁免 | `list` 读取；`add` 追加一条（标题必填、地址必须是 http(s)、最多 48 条、同一地址不重复）；`remove` 按 id 删除。与侧栏 UI 共享一份列表：这里加的会出现在下一个空标签页，人工加的这里也能读到 |

对应 HTTP 接口（写操作同样要求同源与直连回环）：`GET /dsh-builtin-browser/shortcuts`、`POST /dsh-builtin-browser/shortcuts/add`、`POST /dsh-builtin-browser/shortcuts/remove`。并发写入按修订号重试，重试时会基于最新列表重新计算这次编辑，不会覆盖掉另一个写入方的改动。

## 标签与会话

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_list_tabs` | – | `{ tabs: [{ id, url, active }] }` | – | 当前会话的标签列表(输出 schema 只有 `tabs`,**没有 `session` 字段**;会话标识请用 `dsh_browser_session`) |
| `dsh_browser_switch_tab` | `tabId`(必填) | `{ switched }` | ✅ | 按完整会话标签句柄切换标签 |
| `dsh_browser_close_tab` | `tabId`(必填) | `{ closed }` | ✅ | 关闭标签;关闭活动标签后激活下一个。**不属于只读豁免集合,受白名单约束**;`tabId` 只在本会话内查找（传入 `list_tabs` 返回的完整句柄）,陈旧 id 不会关掉别的任务的标签页 |
| `dsh_browser_reset` | – | `{ reset }` | – 豁免 | 关闭本任务所有标签,回到一个空白标签(列入 `READ_ONLY_TOOLS`:限制到空的任务也必须能复位,否则白名单成了陷阱) |
| `dsh_browser_session` | – | `{ session, tabs[] }` | – | 查看本任务的浏览器会话与标签 |
| `dsh_browser_reset_session` | – | `{ reset }` | – 豁免 | 关闭并重建本任务的浏览器会话(崩溃/卡死后恢复;同上,永远可用) |

## 历史与下载

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_history` | `verbose?` | `{ entries[] }` | – | 操作日志(最新在后),含 seq/action/ok/params/result/error。**默认只渲染最近 20 条,且不显示每条的参数**(参数就是你刚发出去的),首行先给总条数,免得把尾部当成全部;要看参数时传 `verbose: true`。返回的完整 `entries[]` 不受条数限制 |
| `dsh_browser_visited` | `limit`(默认 30,上限 200), `domain`(主机名包含匹配), `query`(URL 或标题包含匹配), `session`(按来源会话标签过滤) | `{ count, entries[] }` | – | **持久化浏览历史**(访问过的页面,最新在前):与 cookie 同址落盘(`$DSH_HOME/dsh-builtin-browser-host/history.jsonl`),关闭浏览器与重启 DSH 后仍在;上限默认 5000 条或 90 天(设置文档里的 `history.maxEntries` / `history.maxAgeDays` 可改)。重开某条用 `dsh_browser_open`;与 `dsh_browser_history`(会话内操作日志,随会话消失)是两件事;可在设置里关闭记录。渲染时**时间戳精确到分钟**,会话标记**只在切换时打印一次并取 8 位前缀** |
| `dsh_browser_replay` | `seq`(必填) | `{ replayed }` | ✅ | 按序号回放某一步(navigate/execute/click/type/scroll/key) |
| `dsh_browser_download` | `url`(必填), `savePath`(必填) | `{ path }` | ✅ | 带会话 cookie 下载到本地(仅 http(s);`savePath` 必须为绝对路径且位于 `downloadDir` 内——默认系统下载目录,自动识别 `Downloads`/`下载`/`下載` 与 `XDG_DOWNLOAD_DIR`;不覆盖已有文件;上限 256MB,受 CORS 约束;由子进程直接落盘)。受设置「允许下载文件到磁盘」门控(`BROWSER_DOWNLOAD_DISABLED`) |

## 登录态与安全

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_auth` | `action`(flush/restore,必填), `cookies?` | `{ cookies[]? / restored? }` | ✅ | 导出当前页所属站点的 Cookie 或在受支持的载体恢复 Cookie。无法确定当前站点时拒绝导出。读取和恢复分别要求各自的权限。 |
| `dsh_browser_restrict` | `allowed?` | `{ restrictedTo[] }` | – | 设置动作白名单;空列表解除;**只校验名字是否以 `dsh_browser_` 开头**(写错的前缀会报错,`dsh_browser_typo` 这种拼错但前缀合法的名字会被接受、等同于拦掉该名字,不额外报错);守卫按名字匹配,因此白名单里列什么名字就只放行什么名字。**软护栏**——模型可自行解除,非安全边界 |

## 截图

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh_browser_screenshot` | `fullPage?`, `savePath?`, `format?`(png/jpeg), `quality?`, `maxWidth?`, `maxHeight?` | `{ dataUrl, path?, width?, height? }` | – | 默认 PNG；载体不支持 JPEG 时可返回 PNG。整页截图受合成环境限制。`savePath` 遵循下载目录限制，不覆盖已有文件。 |

## 常用组合

**调研一个网站**
```
dsh_browser_open https://site → dsh_browser_wait(url=...) → dsh_browser_content format=markdown → dsh_browser_snapshot → 逐页浏览
```

**登录并下载文件**
```
打开站点 → dsh_browser_request_takeover(reason=登录) → 核对已登录 → dsh_browser_download(url, savePath)
```

**表单填写(React/Vue 页面)**
```
dsh_browser_snapshot → dsh_browser_fill(fields=[{name:'email',value:'a@b.c'},{label:'备注',value:'测试内容'}], submit=true)
```

**误操作恢复**
```
dsh_browser_reset_session → dsh_browser_open(重新开始)
```

**遇到验证码**
```
dsh_browser_challenge → dsh_browser_request_takeover → 核对用户完成后的页面状态
```
