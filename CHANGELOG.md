# dsh-builtin-browser CHANGELOG

本文件记录各轮功能开发与问题修复(由仓库外独立文档迁入,随仓库管理)。

---

## 第一轮:安全与健壮性修复

- **日期**:2026-08-18
- **对象仓库**:`wqty123/dsh-browser`(DeepSeek Harness 共享浏览器插件,版本 0.1.15)
- **状态**:修复已完成并通过验证,已作为**单独一次提交**保存在本地 git,**未推送**。

---

## 一、改了什么

共修改 **30 个文件**:`src/` 15 个(源码)+ `lib/` 15 个(随仓库发布的构建产物,已重新编译同步)。

| 文件 | 改动内容 |
| --- | --- |
| `src/browser-electron/remote-host.ts` | RPC 认证(随机 token 握手 + 单连接强制);下载自动创建目标目录 |
| `src/browser-electron/host-main.ts` | 首条消息回传 token(hello);窗口 resize 同步视图;弹窗接管;下载流式限流 + Content-Length 提前拒绝 |
| `src/browser-electron/provider.ts` | 下载准入(仅 http/s、绝对路径、`downloadDir` 限定);CDP 超时后打断(terminateExecution / stopLoading);click/type 超时与松键恢复;closeTab 激活下一个标签;快照 selector 用 `CSS.escape`;replay 保留 number/boolean 参数 |
| `src/browser-electron/entry.ts` | 透传新增的 `downloadDir` 配置 |
| `src/browser/types.ts` | 修正准入注释(与实际行为一致) |
| `src/tool-browser/index.ts` | 会话/白名单状态改为每 context 作用域;会话绑定 agent 生命周期自动关闭;`browser_auth` 凭证敏感提示;`browser_history` 对输入文本脱敏;5 个变更型工具改为串行标记 |
| `src/browser/runtime.ts`、`src/index.ts` | 相对导入后缀 `.ts` → `.js` |
| `src/types/electron-shim.d.ts` | 补充 `setWindowOpenHandler` / `loadURL` 类型 |
| `tsconfig.json` | 移除 `allowImportingTsExtensions` / `rewriteRelativeImportExtensions`(修 .d.ts 产物) |
| `lib/**` | 全部按新源码重新构建 |
| `README.md`、`README.en.md`、`docs/architecture.md`、`docs/tool-reference.md`、`docs/user-guide.md` | 修正过时表述(测试脚本、版本号),补充下载准入、`downloadDir`、弹窗行为、RPC 认证说明 |

---

## 二、每个问题修了什么

### 🔴 安全问题

**1. 自托管 RPC 无认证——本机任意进程可接管浏览器(高)**
- 问题:父进程在 loopback 临时端口起 TCP 服务,协议无 token、无身份校验。本机任意进程可抢先伪冒子进程(读到全部命令,包括注入页面的 JS、下载内容、cookie),或在子进程已连接后再连一个 socket 劫持回复(id 从 1 递增可猜),造成页面任意 JS、cookie 窃取、任意文件写入。
- 修复:每次 spawn 生成随机 token(`--rpc-token` 传入);子进程首条消息必须回传该 token(`hello`),认证前命令一律排队不发;服务端只接受**一个**连接,其余直接断开。
- 涉及:`remote-host.ts`、`host-main.ts`。

**2. `browser_download` 任意文件写入 + 无 URL 准入 + 先全量缓冲再限流(高)**
- 问题:`savePath` 完全由 agent 控制可覆盖任意文件;URL 不校验协议(可打本地服务);整个 body 先拉进内存,之后才检查 256MB 上限,超大文件直接 OOM。
- 修复:URL 仅允许 http(s);`savePath` 必须为绝对路径;新增 `downloadDir` 配置,设置后保存路径必须位于该目录内(防 `..` 逃逸);下载改为流式读取,按 `Content-Length` 提前拒绝、边读边限流;自动创建目标目录。
- 涉及:`provider.ts`、`host-main.ts`、`remote-host.ts`、`entry.ts`。

**3. `browser_auth flush` 将全部会话 cookie(含 HttpOnly)明文返回给模型(中)**
- 问题:导出 cookie 是实时登录凭证,模型可能回显进对话或写入日志。
- 修复:工具描述与输出结果均明确标注"LIVE CREDENTIALS——请存私有文件、勿回显、勿入日志"。
- 涉及:`tool-browser/index.ts`。

### 🟠 健壮性问题

**4. CDP 调用超时后底层命令仍挂起 → 会话永久卡死(高)**
- 问题:`withTimeout` 只在父侧 reject,不取消底层 CDP 命令;`awaitPromise: true` 下页面死循环/永不 settle 会占死该 target 的 debugger 队列,后续所有命令排队挂起。
- 修复:超时/中止时 best-effort 发送 `Runtime.terminateExecution` 打断页面脚本(导航超时发 `Page.stopLoading`)。
- 涉及:`provider.ts`。

**5. 任务会话泄漏 + 模块级全局状态破坏多 context 隔离(中)**
- 问题:会话映射/白名单是模块级变量,多 context 共享串扰(`browser_restrict` 一个任务限制全局生效);任务结束没有任何 hook 关闭会话,窗口/视图只增不减。
- 修复:全部状态改为**每插件 apply(每 context)作用域**;会话生命周期绑定 agent 作用域 ctx(`agent.ctx`),agent(DSH 会话)销毁时自动关闭浏览器会话。
- 涉及:`tool-browser/index.ts`。

**6. 自托管窗口 resize 后视图不跟随(中)**
- 问题:视图只在创建时设置一次 bounds,窗口调整大小后页面尺寸错位。
- 修复:监听窗口 `resize` 事件,同步更新全部视图 bounds。
- 涉及:`host-main.ts`。

**7. 弹窗不受控(中)**
- 问题:页面 `window.open` / `target=_blank` 会打开未跟踪的原生窗口,破坏"标签即会话"模型。
- 修复:`setWindowOpenHandler` 拒绝弹窗,并把 http(s) 弹窗重定向到当前标签页内打开。
- 涉及:`host-main.ts`、`electron-shim.d.ts`。

**8. click/type 无超时 + 状态污染(中)**
- 问题:`click` 的 press/release 是两个独立命令且无超时;中途失败会留下"鼠标按住"状态。
- 修复:两个命令均包 30s 超时;press 成功后 release 失败时 best-effort 补发 release。
- 涉及:`provider.ts`。

### 🟡 正确性 / 小问题

| # | 问题 | 修复 |
| --- | --- | --- |
| 9 | `closeTab` 关闭活动标签后激活**最后一个**标签,文档写"激活下一个" | 改为激活下一个(被关闭的是最后一个时收敛到上一个) |
| 10 | 发布包 `.d.ts` 仍引用 `./types.ts`(TS 的 `rewriteRelativeImportExtensions` 只改 `.js` 不改 `.d.ts`,见 TS#61037) | 源码相对导入改 `.js` 后缀,移除两个不再需要的编译选项,重新构建 `lib/` |
| 11 | 快照 selector 用 `'#' + id`,含特殊字符的 id 生成无效 CSS | 改用 `CSS.escape(id)` |
| 12 | `browser_history` 暴露 `type` 输入文本(可能含密码) | 工具输出脱敏(provider 内部保留原文供 `browser_replay` 使用) |
| 13 | `browser_open` 等 5 个会变更会话状态的工具标记 `isConcurrencySafe: true` | 全部改为 `false`(框架内 exclusive 串行) |
| 14 | 类型注释声称"拒绝凭据/私网目标",实现并未做 | 修正注释为"仅 HTTP(S) 准入",明确不拦 localhost(共享浏览器合法访问本地开发服务) |
| 15 | `browser_replay` 只保留 string 类型的 args | 保留 string/number/boolean |
| 16 | README 声称"见仓库测试脚本"(仓库实际无测试),版本号写 0.1.11(实际 0.1.15) | 修正两处表述,并同步补充新行为说明 |

---

## 三、验证情况

- `tsc --noEmit`:零错误(本地临时安装 TypeScript 5.9.3 + peer 依赖验证,验证后已清理 `node_modules`)。
- 构建产物:重新编译 `lib/`,声明文件 `.d.ts` 的导入后缀已全部为 `.js`。
- 冒烟测试(用假 `ElectronBrowserViewHost` 驱动编译后的 provider,共 15 项断言全部通过):
  - closeTab 激活逻辑(关闭活动/非活动/中间标签);
  - 下载准入:非 http(s) 拦截、相对路径拦截、`..` 逃逸拦截、目录内放行;
  - 挂起的 `Runtime.evaluate` 超时返回 `BROWSER_EXECUTE_TIMEOUT` 且触发 `Runtime.terminateExecution`;
  - click 第一次 release 失败后自动补发 release(不留"按住"状态)。

---

## 四、备注

- 本次提交**未 bump 版本号**(当前仍为 0.1.15);如需发布,按仓库惯例应 bump 到 0.1.16 并重新 `prepack`。
- 改动已提交到本地 git(**未推送**);如需上传请另行告知。

---

# 第二轮:功能补全与体验优化(2026-08-18)

在第一轮修复之后,针对评审列出的剩余不足做了一轮功能补全。同样已作为单独一次提交保存在本地 git,未推送。

## 改了什么

| 文件 | 改动内容 |
| --- | --- |
| `src/browser-electron/host-main.ts` | 窗口标题实时显示当前可见会话(任务)+ 页面标题/URL;重复 showView 跳过 remove/re-add 消除闪烁;下载改为子进程直接落盘(临时文件 + rename,不再经 RPC 传 base64);截图支持 JPEG/缩放 |
| `src/browser-electron/provider.ts` | 新增 `waitFor`/`scroll`/`back`/`forward`/`key`;快照穿透 iframe/Shadow DOM(绝对坐标 + frame 标记);content 的 txt/markdown 穿透;challenge 检测扫同源 iframe/shadow;`available()` 委托 host 探测;`downloadDir` 默认收敛到 `~/Downloads`;快照脚本先 rect 后 style |
| `src/browser-electron/remote-host.ts` | `showView` 携带会话 label;`available()` 探测 Electron 二进制(带缓存);Electron 扫描范围收敛(去掉 cwd/execPath);capture 透传格式/缩放参数 |
| `src/browser/types.ts` | 新增 `BrowserWaitRequest/Result`、`BrowserScrollRequest`、`BrowserKeyRequest`;`open(label?)`;快照元素 `frame` 标记;截图 `format/quality/maxWidth/maxHeight` |
| `src/browser/runtime.ts` | seam 透传 `waitFor`/`scroll`/`back`/`forward`/`key`/`open(label)` |
| `src/tool-browser/index.ts` | 新增 6 个工具:`browser_wait`、`browser_scroll`、`browser_back`、`browser_forward`、`browser_key`;`browser_screenshot` 增加 JPEG/缩放参数;`browser_restrict` 标注为软护栏 |
| `src/types/electron-shim.d.ts` | `setTitle`/`getTitle`/`getURL`/`toJPEG`/`resize` |
| `package.json` | 新增 `test` 脚本 |
| `tests/provider.test.mjs` | 新增 11 项单元测试(假 host,无需 Electron) |
| `.github/workflows/ci.yml` | 新增 CI(安装/构建/测试) |
| `README.md`、`README.en.md`、`docs/*` | 工具表、配置表、已知限制、操作纪律、自托管说明同步更新 |
| `lib/**` | 重新构建 |

## 每个问题怎么解决的

| # | 问题 | 解决 |
| --- | --- | --- |
| 7 | 多任务可见性:多会话抢同一窗口、无归属标识、每次操作视图闪烁 | 窗口标题实时显示当前可见会话(任务)+ 页面标题/URL;重复 showView 跳过 remove/re-add(消除每次操作的闪烁);resize 自动跟随 |
| 1 | 看不到 iframe / Shadow DOM 内容 | 快照穿透同源 iframe 与 shadow root(跨域 iframe 受浏览器安全限制仍不可读),iframe 内元素标注 `frame` 且坐标换算为顶层文档绝对坐标;content 的 txt/markdown、challenge 检测同步穿透 |
| 2 | 没有等待页面就绪原语(白屏快照重试) | 新增 `browser_wait`(等加载完成 + 可选期望 URL/选择器,未就绪返回原因不抛错) |
| 3 | 交互原语太裸 | 新增 `browser_scroll`(增量/选择器/顶底)、`browser_back`/`browser_forward`(历史)、`browser_key`(Enter/Tab/方向键等命名按键) |
| 4 | `available()` 恒为 true,provider 选择逻辑形同虚设 | host 增加可选 `available()` 探测;自托管 host 探测 Electron 二进制(缓存),缺失时返回 `BROWSER_PROVIDER_UNAVAILABLE` |
| 5 | 桌面壳下 download/auth 不可用 | 属宿主层能力缺口(宿主未实现该接缝方法),文档明确标注自托管专用;接缝已就绪 |
| 6 | 平台承诺窄(仅 Windows 实测) | 属实测范围问题,保持文档如实声明(macOS/Linux 未验证) |
| 8 | `browser_restrict` 是软护栏但未说明 | 工具描述与文档明确标注:防误操作软护栏,模型可自行解除,非安全边界 |
| 9 | `downloadDir` 默认未设置,agent 仍可写任意路径 | 默认收敛到 `~/Downloads`(系统下载目录,人类可见),可配置 `downloadDir` 覆盖为沙箱目录 |
| 10 | cookie 明文落盘;下载走 base64 大消息(内存峰值高) | 下载改为**子进程直接写文件**(临时文件 + rename),body 不再经 RPC 传输,彻底消除大消息;cookie 明文属 Electron 默认行为,文档标注需宿主层钥匙串/DPAPI |
| 11 | Electron 二进制扫描范围过广(可能捡到无关项目) | 扫描范围收敛为插件自身安装树 + DSH 锚点,去掉 cwd/execPath |
| 12 | 零测试、零 CI | 新增 `tests/provider.test.mjs`(11 项,假 host 无需 Electron)+ `package.json test` + GitHub Actions CI |
| 13 | 快照性能(O(n) 布局抖动) | 先 `getBoundingClientRect` 后 `getComputedStyle`(只有尺寸通过才强制样式重算) |
| 14 | 截图仅 PNG 且不可缩放 | 自托管原生路径支持 JPEG(`toJPEG`)+ 等比缩放(`maxWidth`/`maxHeight`);桌面壳 CDP 回退仍 PNG(平台缺陷) |

## 验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` 11 项全部通过:标签生命周期、`open(label)` 透传、`available()` 委托、下载准入(协议/相对路径/`..` 逃逸/默认目录)、`waitFor` 就绪与超时、挂起 execute 超时并触发 terminate、click 失败补发 release、key 支持/拒绝未知、back/forward 步进与边界空操作、scroll 记录。

## 备注

- 新增工具后共 25 个 `browser_*` 工具(原 20 + wait/scoll/back/forward/key)。
- 未 bump 版本号;未推送。

---

# 第三轮 + 审查修复说明 (commit 87508cc)

- **日期**:2026-08-18
- **状态**:已提交,未推送。22 个文件,+4271/-429 行。

## 一、第三轮新增功能

| 特性 | 文件 |
| --- | --- |
| browser_a11y:无障碍树工具(role/name/value/states/坐标,iframe/shadow 穿透) | provider.ts, types.ts, runtime.ts, index.ts |
| browser_scrape:静态 CSS 结构化提取(不执行任意代码) | provider.ts, types.ts, runtime.ts, index.ts |
| browser_set_value/check/select/clear/get_value:完整表单控件 | provider.ts, types.ts, runtime.ts, index.ts |
| browser_click/type 支持 target {by: css/text/xpath, value} 语义定位 | provider.ts, types.ts, runtime.ts, index.ts |
| browser_refresh:刷新当前页 | provider.ts, types.ts, runtime.ts, index.ts |
| 每个会话独立 BrowserWindow + 真实工具栏(地址栏/后退前进/刷新/标签条) | host-main.ts |
| 用户工具栏操作路由回会话模型(人和 agent 共享标签/导航) | host-main.ts, remote-host.ts, provider.ts |

## 二、审查修复 (5 HIGH + 10 MEDIUM)

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | HIGH | RPC token 通过 --rpc-token argv 暴露给同用户进程 | token 改从 stdin 传入(首行);spawn stdio 改为 pipe |
| 2 | HIGH | browser_replay 的 type 条目绕过脱敏 | 挂载对 replay+type / replay+setValue 同样掩码;execute 脚本/参数/结果全部脱敏 |
| 3 | HIGH | host-main Cookie.domain? 合并 string 类型错误 | `c.domain ?? ''` 兜底 |
| 4 | HIGH | CI pnpm cache 需要 lockfile(仓库无) | 改用 npm + npx tsc + node --test |
| 5 | HIGH | README 声称"无测试套件"但已新增 | 修正 README/README.en |
| 6 | MEDIUM | download() 超时无打断 | 文档化(子进程无 abort 机制,父侧 pending 已清理) |
| 7 | MEDIUM | downloadDir 大小写敏感(Windows 假拒绝合法路径) | 比较前 toLowerCase() |
| 8 | MEDIUM | 默认 ~/Downloads 可能是 OneDrive 重定向 | 注释+文档说明非安全边界 |
| 9 | MEDIUM | terminatePage 无界 fire-and-forget | WeakMap 计数,上限 3 并发 |
| 10 | MEDIUM | 无 agent 的 default 会话永不关闭 | process.on('exit') 清理 |
| 11 | MEDIUM | agent.ctx.effect 抛错后 pendingOpens 永久毒化 | 先 set/delete 再 effect,catch 中 undo |
| 12 | MEDIUM | browser_close_tab 缺 assertAllowed | 补上 |
| 13 | MEDIUM | restrictedTo 跨任务泄漏疑虑 | 注释澄清:per-Cordis-context = per-task |
| 14 | MEDIUM | 窗口销毁后标题残留;OAuth window.open 被拒 | 销毁可见视图后重置标题;非 http(S) popup 放行 |

## 三、验证

- `tsc --noEmit` 零错误。
- `node --test tests/*.test.mjs` 18 项全部通过(含第三轮新增: a11y、form ops、scrape、target、userAction、reload)。
- 版本号未 bump。三轮合计 3 个提交未推送。

---

# 第四轮:DSH 更新对齐 + 复查修复

## 一、DSH 更新对齐

- DSH(Harness)已更新到 **0.1.1-rc.2**(`@deepseek-ai/dsh` latest = next = 0.1.1-rc.2;`dsh-llm`/`dsh-tools`/`dsh-system-prompt` 同版本)。
- 验证:用 0.1.1-rc.2 安装后 `tsc --noEmit` 零错误、18 项既有测试全绿 —— 插件与新版 DSH 完全兼容。
- `package.json` peerDependencies 下限从 `^0.1.0-rc.1` 对齐到 **`^0.1.1-rc.2`**(语义上旧范围已覆盖,显式对齐当前基线)。
- `cordis`(4.0.1)、`schemastery`(3.18.1)无更新。

## 二、复查发现并修复的问题

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | **HIGH** | `type()` 带 target 时把文本丢弃(只发空 insertText)——上次审查已点名,本轮确认仍存在 | `'text' in request ? request.text : ''`,保留文本并记录进 history |
| 2 | MEDIUM | `key()` Space 缺 CDP `text` 字段,输入框收不到空格字符 | KEY_SPECS.Space 增加 `text: ' '`,keyDown 参数透传 |
| 3 | MEDIUM | `key()` keyUp 失败无释放恢复(键可能卡住按下) | 仿 click 的 release 恢复:press/release 分离,失败重试 release |
| 4 | MEDIUM | `waitFor` URL 前缀匹配跨域误匹配(https://a.com 匹配 https://a.com.evil.com) | 仅同 origin 内允许前缀匹配,否则要求精确相等 |
| 5 | LOW | hello 竞态:子进程在 stdin token 到达前连接会发空 token(被父进程当伪造连接) | 连接回调等待 stdin 首行/超时兜底后再发 hello;顺带修复 stdin readline 变量名与 socket readline 遮蔽问题 |
| 6 | LOW | `snapshotMaxElements`/`contentMaxChars` 配置未接线(provider 接受但入口不暴露) | entry.ts Config 增加两个字段并透传 |
| 7 | LOW | index.ts 缺第三轮新类型导出(a11y/scrape/target/form ops 等) | 全部补上 |
| 8 | LOW | 下载 `.part` 临时文件 rename 失败时残留 | catch 中 unlinkSync 清理后重抛 |

## 三、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` **20 项**全部通过(新增 3 项回归:type-with-target 不丢文本、Space 带 text、waitFor 同源判定)。
- 版本号未 bump。四轮合计 4 个提交未推送。

---

# 第五轮:修复 electron 44 懒下载导致插件不可用 + 构建回归

## 一、症状与根因

- 症状:安装后用 pnpm 装依赖,插件报不可用/浏览器起不来。
- 根因一:electron 44+ **不再有 postinstall**,改为**首次 `require('electron')` 时懒下载**二进制。pnpm 安装后 `node_modules/electron/` 里没有 `dist/` 与 `path.txt`(二进制缺失)。插件的 `available()` 探测走 `require('electron')`,会在 DSH 启动/provider 选择时**同步阻塞下载**(或离线失败),表现为插件不可用。
- 根因二:装上 electron 44 后其自带类型把 `Cookie.domain` 标为可选,`flushAuth` 里两处裸用 `c.domain` 触发 TS18048,`tsc` 构建必挂(HIGH 3 的修复当时只覆盖了导出对象一处)。

## 二、修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | `available()` 探测触发 electron 懒下载,阻塞/失败 | `resolveElectronPath()` 改为无副作用探测:先检查 `path.txt`/`dist` 是否已下载,已下载才 `require('electron')`;未下载走 ELECTRON_PATH/锚点/自身安装树扫描,全部缺失时抛错(不触发网络下载) |
| 2 | 二进制缺失时错误信息没给指引 | 错误信息补充:Electron 44+ 首次使用自动下载(需网络),可先跑 `npx install-electron` 或设 `ELECTRON_PATH` |
| 3 | `flushAuth` 的 `c.domain` 两处裸用导致构建失败 | `const domain = c.domain ?? ''`,host/hostPart/导出均基于它 |
| 4 | 首次使用无感知 | 懒下载仍保留在真正 spawn 时触发(electron 44 官方机制);首次运行需网络 |

## 三、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` 20 项全部通过。
- `RemoteElectronViewHost.available()` 实测 **6ms** 返回(纯文件系统探测,不再触发下载);electron 44 二进制下载后正常定位。
- 版本号未 bump。五轮合计 5 个提交未推送。
