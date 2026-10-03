# 工具参考

全部 34 个 `browser_*` 工具。守卫列:✅ 表示该动作受 `browser_restrict` 白名单约束;**「– 豁免」表示无论白名单怎么写都不拦截**(豁免集合为 `READ_ONLY_TOOLS`,`src/tool-browser/index.ts` 导出:**只观察的工具** —— `snapshot`/`a11y`/`content`/`scrape`/`screenshot`/`get_value`/`wait`/`challenge`/`list_tabs`/`session`/`history`/`visited` —— 加上 **解除限制 / 从坏状态恢复的工具** `restrict`/`reset_session`/`reset`;`restrict` 在其中,否则限制到空的任务再也解不开);**「–」表示该工具只观察、不做动作**,故没有可拦的东西。两者之外的工具都受白名单约束 —— 例如 `browser_close_tab`、`browser_auth` 都不属于豁免集合(`browser_auth` 的 `restore` 会向任意域写 cookie,是动作,不是观察)。

## 页面与导航

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_open` | `url`(必填), `newTab?` | 快照(url/title/elements/truncated/challenge) | ✅ | 打开 URL,返回带编号元素的快照;`newTab: true` 在新标签打开 |
| `browser_wait` | `timeoutMs?`, `url?`, `selector?` | `{ ready, reason }` | – | 等待页面加载完成(可选期望 URL / CSS 选择器);未就绪不抛错,返回原因 |
| `browser_snapshot` | – | 快照 | – | 交互元素(输入框/按钮/链接)编号清单,供定位与点击;穿透同源 iframe 与 Shadow DOM,iframe 内元素标注 `frame`。元素有 `id` 或 `name` 时,每行末尾附**可直接引用**的 `{#id}` / `{[name=x]}`(推导不出来时该段不出现),可原样作为 `browser_click`/`browser_type` 的 `target {by:"css", value:"…"}` |
| `browser_a11y` | `includeHidden?`, `maxNodes?`(10-5000,**默认 150**), `coords?` | `{ url, title?, count, nodes[], truncated }` | – | 无障碍树:每个交互节点的 `role`/`name`/`value`/`states`/`depth`/`tag`/`selector`,优先 Chrome `computedRole`/`computedName`,穿透同源 iframe 与 Shadow DOM。**默认不返回坐标**(需要像素落点时传 `coords: true`;要按文本驱动目标,用节点的 `name` 配 `browser_click` 的 `target {by:"text"}`)。`states` **省略字面量 `enabled`（`unchecked`、`collapsed` 等仍会打印）** —— 没有 `states=` 就是 enabled;缩进为一层一个空格 |
| `browser_content` | `format`(html/markdown/txt/json,必填), `selector?`, `maxChars?`, `timeoutMs?` | `{ content, truncated }` | – | 抓取页面内容;`selector` 限定区域。**字符上限按格式**(默认):`html`/`json` **50 000**,`txt`/`markdown` **20 000**,单次调用用 `maxChars` 覆盖;被截断时结果末尾提示如何收窄。`json` 返回 `{"html": "<元素 outerHTML>", "tag": "<标签名>"}` —— 不是空对象(DOM 节点自身没有可枚举属性,`JSON.stringify` 一个元素只会得到 `{}`) |
| `browser_challenge` | – | `{ blocked, kind?, reason?, hint? }` | – | 检测人机验证(CAPTCHA/Cloudflare/reCAPTCHA/hCaptcha/Turnstile);阻塞时请用户处理 |

## 页面操作

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_execute` | `script`(必填), `args?` | `{ ok, value? / exception? }` | ✅ | 在页面执行 JS;脚本以 `return` 开头或作为表达式;`args` 以 `arguments[0..n]` 传入。**返回值上限 50 000 字符**,超出时结果里写明"截断于 50 000 / 实际 N 字符"(要完整内容请让表达式返回更小的值)。受设置「Agent 能做什么 → 允许在页面里执行脚本」门控,关闭后一律被拒(`BROWSER_EXECUTE_DISABLED`),且没有任何工具能把它打开 |
| `browser_click` | `target?`(css/text/xpath), `x?`, `y?`(target 与坐标二选一) | `{ clicked }` | ✅ | 语义目标点击:按 `target` 定位、滚动到视口中央再点中心;或视口坐标点击(配合截图做视觉定位) |
| `browser_type` | `text`(必填), `target?` | `{ typed }` | ✅ | 输入文本;传 `target` 先聚焦该元素(CDP `Input.insertText`) |
| `browser_key` | `key`(必填,枚举) | `{ pressed }` | ✅ | 按命名按键:Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space |
| `browser_scroll` | `deltaX?`, `deltaY?`, `selector?`, `toTop?`, `toBottom?` | `{ scrolled }` | ✅ | 滚动页面:像素增量 / 选择器定位 / 顶部底部 |
| `browser_back` | – | `{ back }` | ✅ | 页面历史后退一步(无前项时为空操作) |
| `browser_forward` | – | `{ forward }` | ✅ | 页面历史前进一步(无后项时为空操作) |
| `browser_refresh` | – | `{ refreshed }` | ✅ | 刷新当前页(等价浏览器刷新按钮) |
| `browser_fill` | `fields`(必填,数组), `submit?` | `{ fields[], submitted }` | ✅ | 批量填表;字段按 `selector`/`name`/`label`/`placeholder` 匹配,值支持字符串/数字/布尔;单个字段失败不影响其余;`submit: true` 提交表单 |
| `browser_set_value` | `target`(必填), `value`(必填) | `{ method, value }` | ✅ | 单个控件设值(按 css/text/xpath 定位);原生 setter + input/change,React 受控输入可用;select 按值/文本 |
| `browser_check` | `target`(必填), `checked?` | `{ checked }` | ✅ | 勾选/取消勾选 checkbox 或 radio(按 target 定位) |
| `browser_select` | `target`(必填), `optionValue?`/`optionText?`/`optionIndex?`(三选一) | `{ value, text }` | ✅ | 选中 `<select>` 的某个选项(按 target 定位) |
| `browser_clear` | `target`(必填) | `{ cleared }` | ✅ | 清空输入/文本域/contenteditable,或取消勾选 checkbox/radio |
| `browser_get_value` | `target`(必填) | `{ value?, checked?, selectedText? }` | – 豁免 | 读取元素当前值,用于操作后验证 |
| `browser_scrape` | `item`(必填), `fields`(必填,映射), `timeoutMs?` | `{ count, items[] }` | – 豁免 | 结构化提取:容器选择器 + 字段映射(如 `{"title": "h3", "url": "a@href"}`);静态 CSS 查询、不执行任意代码、CSP 安全;等待 item 出现(默认 5s)。**结果是最紧凑的 JSON**(不缩进),条目数在最前面 |

## 标签与会话

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_list_tabs` | – | `{ tabs: [{ id, url, active }] }` | – | 当前会话的标签列表(输出 schema 只有 `tabs`,**没有 `session` 字段**;会话标识请用 `browser_session`) |
| `browser_switch_tab` | `tabId`(必填) | `{ switched }` | ✅ | 按 id 切换标签;自托管下同步切换可见视图 |
| `browser_close_tab` | `tabId`(必填) | `{ closed }` | ✅ | 关闭标签;关闭活动标签后激活下一个。**不属于只读豁免集合,受白名单约束**;`tabId` 只在本会话内查找(接受 `tab:<uuid>` 或裸 uuid),陈旧 id 不会关掉别的任务的标签页 |
| `browser_reset` | – | `{ reset }` | – 豁免 | 关闭本任务所有标签,回到一个空白标签(列入 `READ_ONLY_TOOLS`:限制到空的任务也必须能复位,否则白名单成了陷阱) |
| `browser_session` | – | `{ session, tabs[] }` | – | 查看本任务的浏览器会话与标签 |
| `browser_reset_session` | – | `{ reset }` | – 豁免 | 关闭并重建本任务的浏览器会话(崩溃/卡死后恢复;同上,永远可用) |

## 历史与下载

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_history` | `verbose?` | `{ entries[] }` | – | 操作日志(最新在后),含 seq/action/ok/params/result/error。**默认只渲染最近 20 条,且不显示每条的参数**(参数就是你刚发出去的),首行先给总条数,免得把尾部当成全部;要看参数时传 `verbose: true`。返回的完整 `entries[]` 不受条数限制 |
| `browser_visited` | `limit`(默认 30,上限 200), `domain`(主机名包含匹配), `query`(URL 或标题包含匹配), `session`(按来源会话标签过滤) | `{ count, entries[] }` | – | **持久化浏览历史**(访问过的页面,最新在前):与 cookie 同址落盘(`$DSH_HOME/dsh-builtin-browser-host/history.jsonl`),关闭浏览器与重启 DSH 后仍在;上限 5000 条或 90 天。重开某条用 `browser_open`;与 `browser_history`(会话内操作日志,随会话消失)是两件事;可在设置里关闭记录。渲染时**时间戳精确到分钟**,会话标记**只在切换时打印一次并取 8 位前缀** |
| `browser_replay` | `seq`(必填) | `{ replayed }` | ✅ | 按序号回放某一步(navigate/execute/click/type/scroll/key) |
| `browser_download` | `url`(必填), `savePath`(必填) | `{ path }` | ✅ | 带会话 cookie 下载到本地(仅 http(s);`savePath` 必须为绝对路径且位于 `downloadDir` 内——默认系统下载目录,自动识别 `Downloads`/`下载`/`下載` 与 `XDG_DOWNLOAD_DIR`;不覆盖已有文件;上限 256MB,受 CORS 约束;由子进程直接落盘)。受设置「允许下载文件到磁盘」门控(`BROWSER_DOWNLOAD_DISABLED`) |

## 登录态与安全

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_auth` | `action`(flush/restore,必填), `cookies?` | `{ cookies[]? / restored? }` | ✅ | 导出/恢复 cookie —— **三种载体都可用**:自托管走原生会话,桌面侧栏与本机 Chrome/Edge 走 CDP 的 `Network.getCookies` / `Storage.setCookies`;flush 返回 cookie 列表,restore 带列表写回。**flush 只导出当前页所属站点的 cookie**(不是整台机器的共享 cookie 罐),范围按本会话所在页面的 URL 收敛;**范围未知时直接拒绝而不是放宽**(自托管侧栏载体报"cookie 范围未知",CDP 载体报 `BROWSER_AUTH_SCOPE_UNKNOWN`)。`restored` 反映真的提交了多少(无法构成有效 URL 的 cookie 会被丢弃并报出条数)。**受白名单约束**:`restore` 会向任意域写 cookie,是动作而非观察,因此该工具**不在只读豁免集合**里。设置里「允许读取 cookies / 导出登录状态」关闭时,flush 与 restore **都**抛 `BROWSER_AUTH_DISABLED`。导出受设置「凭据」门控(`BROWSER_AUTH_DISABLED`),写入受「允许写入登录状态」门控(`BROWSER_AUTH_WRITE_DISABLED`)—— 两者独立 |
| `browser_restrict` | `allowed?` | `{ restrictedTo[] }` | – | 设置动作白名单;空列表解除;**只校验名字是否以 `browser_` 开头**(写错的前缀会报错,`browser_typo` 这种拼错但前缀合法的名字会被接受、等同于拦掉该名字,不额外报错);守卫按名字匹配,因此白名单里列什么名字就只放行什么名字。**软护栏**——模型可自行解除,非安全边界 |

## 截图

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_screenshot` | `fullPage?`, `savePath?`, `format?`(png/jpeg), `quality?`, `maxWidth?`, `maxHeight?` | `{ dataUrl, path? }` | – | 截图;PNG 默认,**JPEG 在自托管与本机 Chrome/Edge 上都可用**(自托管在原生 `capturePage` 路径编码,本机浏览器经 CDP 声明 `supportsCdpJpeg`;**桌面侧栏**的 Electron CDP JPEG 编码器会挂起,该载体下 JPEG 请求返回 PNG);`maxWidth`/`maxHeight` 等比缩放**三种载体都支持**;`fullPage` 会跳过原生 `capturePage`、三种载体统一走 CDP `captureBeyondViewport`;`savePath` 落盘供视觉模型读取(与 `browser_download` 同一准入门:必须位于 `downloadDir` 内且不覆盖已有文件) |

## 常用组合

**调研一个网站**
```
browser_open https://site → browser_wait(url=...) → browser_content format=markdown → browser_snapshot → 逐页浏览
```

**登录并下载文件**
```
browser_open https://site/login → browser_fill(用户名/密码) submit=true →
等待跳转 → browser_download(url, savePath)
```

**表单填写(React/Vue 页面)**
```
browser_snapshot → browser_fill(fields=[{name:'email',value:'a@b.c'},{label:'密码',value:'***'}], submit=true)
```

**误操作恢复**
```
browser_reset_session → browser_open(重新开始)
```

**遇到验证码**
```
browser_challenge → 阻塞 → 提示用户:"页面出现人机验证,请在共享浏览器窗口完成,完成后告诉我" →
browser_snapshot 复查
```
