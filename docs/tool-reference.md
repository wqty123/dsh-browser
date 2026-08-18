# 工具参考

全部 33 个 `browser_*` 工具。守卫列:✅ 表示该动作受 `browser_restrict` 白名单约束;只读工具永不拦截。

## 页面与导航

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_open` | `url`(必填), `newTab?` | 快照(url/title/elements/truncated/challenge) | ✅ | 打开 URL,返回带编号元素的快照;`newTab: true` 在新标签打开 |
| `browser_wait` | `timeoutMs?`, `url?`, `selector?` | `{ ready, reason }` | – | 等待页面加载完成(可选期望 URL / CSS 选择器);未就绪不抛错,返回原因 |
| `browser_snapshot` | – | 快照 | – | 交互元素(输入框/按钮/链接)编号清单,供定位与点击;穿透同源 iframe 与 Shadow DOM,iframe 内元素标注 `frame` |
| `browser_a11y` | `includeHidden?`, `maxNodes?`(10-5000,默认 500) | `{ url, title?, count, nodes[], truncated }` | – | 无障碍树:每个交互节点的 `role`/`name`/`value`/`states`/`depth`/`tag`/坐标;优先 Chrome `computedRole`/`computedName`,穿透同源 iframe 与 Shadow DOM;坐标可直接喂 `browser_click`/`browser_type` |
| `browser_content` | `format`(html/markdown/txt/json,必填), `selector?`, `maxChars?`, `timeoutMs?` | `{ content, truncated }` | – | 抓取页面内容;`selector` 限定区域 |
| `browser_challenge` | – | `{ blocked, kind?, reason?, hint? }` | – | 检测人机验证(CAPTCHA/Cloudflare/reCAPTCHA/hCaptcha/Turnstile);阻塞时请用户处理 |

## 页面操作

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_execute` | `script`(必填), `args?` | `{ ok, value? / exception? }` | ✅ | 在页面执行 JS;脚本以 `return` 开头或作为表达式;`args` 以 `arguments[0..n]` 传入 |
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
| `browser_get_value` | `target`(必填) | `{ value?, checked?, selectedText? }` | – | 读取元素当前值,用于操作后验证 |
| `browser_scrape` | `item`(必填), `fields`(必填,映射), `timeoutMs?` | `{ count, items[] }` | – | 结构化提取:容器选择器 + 字段映射(如 `{"title": "h3", "url": "a@href"}`);静态 CSS 查询、不执行任意代码、CSP 安全;等待 item 出现(默认 5s) |

## 标签与会话

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_list_tabs` | – | `{ session, tabs[] }` | – | 当前会话的标签列表 |
| `browser_switch_tab` | `tabId`(必填) | `{ switched }` | ✅ | 按 id 切换标签;自托管下同步切换可见视图 |
| `browser_close_tab` | `tabId`(必填) | `{ closed }` | – | 关闭标签;关闭活动标签后激活下一个 |
| `browser_reset` | – | `{ reset }` | ✅ | 关闭本任务所有标签,回到一个空白标签 |
| `browser_session` | – | `{ session, tabs[] }` | – | 查看本任务的浏览器会话与标签 |
| `browser_reset_session` | – | `{ reset }` | ✅ | 关闭并重建本任务的浏览器会话(崩溃/卡死后恢复) |

## 历史与下载

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_history` | – | `{ entries[] }` | – | 操作日志(最新在后),含 seq/action/ok/params/result/error |
| `browser_replay` | `seq`(必填) | `{ replayed }` | ✅ | 按序号回放某一步(navigate/execute/click/type/scroll/key) |
| `browser_download` | `url`(必填), `savePath`(必填) | `{ path }` | ✅ | 带会话 cookie 下载到本地(仅 http(s);`savePath` 必须为绝对路径,默认限定在 `~/Downloads`,可用 `downloadDir` 覆盖;上限 256MB,受 CORS 约束;由子进程直接落盘) |

## 登录态与安全

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_auth` | `action`(flush/restore,必填), `cookies?` | `{ cookies[]? / restored? }` | ✅ | 导出/恢复 cookie(自托管可用);flush 返回 cookie 列表,restore 带列表写回 |
| `browser_restrict` | `allowed?` | `{ restrictedTo[] }` | – | 设置动作白名单;空列表解除;未知工具名报错。**软护栏**——模型可自行解除,非安全边界 |

## 截图

| 工具 | 参数 | 输出 | 守卫 | 说明 |
| --- | --- | --- | --- | --- |
| `browser_screenshot` | `fullPage?`, `savePath?`, `format?`(png/jpeg), `quality?`, `maxWidth?`, `maxHeight?` | `{ dataUrl, path? }` | – | 截图;PNG 默认,JPEG 仅自托管原生路径;`maxWidth`/`maxHeight` 等比缩放降低视觉模型开销;`savePath` 落盘供视觉模型读取 |

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
