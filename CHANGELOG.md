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

## 三、补充修复:Windows 握手回归(RPC token 收不到)

- 症状:真机端到端验证时子进程日志 `warning: no token received on stdin`,hello 带空 token,认证失败,插件完全不可用。
- 根因:Windows 上 **Electron 是 GUI 子系统进程,收不到 piped stdin**。第一轮把 token 从 argv 改为 stdin 传递(安全修复)在 Windows 上直接断了握手——旧版(argv)能跑,新版(stdin)跑不了。
- 修复:token 双通道传递 —— spawn 时同时写入 stdin **和** `DSH_BROWSER_RPC_TOKEN` 环境变量;子进程 **stdin 优先、env 兜底**(Windows GUI 收不到 stdin 时用 env;env 比 argv 隐蔽,默认进程列表工具不可见)。

## 四、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` 20 项全部通过。
- `RemoteElectronViewHost.available()` 实测 **6ms** 返回(纯文件系统探测,不再触发下载);electron 44 二进制下载后正常定位。
- **真实端到端验证通过**(真机 Windows):spawn electron → stdin/env token 握手 → `navigate` → `snapshot` → `listTabs` → `close` 全链路 E2E PASS。
- 版本号未 bump。五轮合计 5 个提交未推送。

---

# 第六轮:修复自托管模式下 switch_tab/close_tab 按 id 操作失败

## 一、症状

自托管(plain dsh web)模式下:`browser_switch_tab` 对任何 tab id 都报 `tab "<id>" is not open in this session`;`browser_close_tab` 返回 `closed: true` 但标签没关。其余工具全部正常。

## 二、根因

- **closeTab 静默假成功**:tab 找不到时 `index < 0` 直接 resolve(幂等设计),返回 `closed: true` 掩盖了真实错误——这就是"返回 Closed. 但没关闭"。
- **按 id 查找被限定在"调用方 session"内**:工具层 `ensureSession` 解析出的 session 与实际持有该 tab 的 session 可能错位(宿主工具执行上下文差异),导致 findIndex 找不到。tab id 是全局唯一的 UUID,但查找范围错了。

## 三、修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | closeTab 静默假成功 | 找不到时改为抛出 `BROWSER_TAB_UNKNOWN`(与 switchTab 一致),不再返回假成功 |
| 2 | 按 id 查找限定调用方 session | 新增 `locateTab()`:优先调用方 session,找不到则**跨全部 session 按 id 兜底**(tab id 全局唯一,不会误命中其他任务);真的不存在才抛错 |
| 3 | 错误无诊断信息 | `BROWSER_TAB_UNKNOWN` 信息附带调用方 session 的现有 tab id 列表,便于线上定位 |

## 四、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` **21 项**全部通过(新增:跨 session 切换/关闭兜底、未知 id 抛错回归测试)。
- 版本号未 bump。六轮合计 6 个提交未推送。

---

## 第七轮:内置浏览器工具栏交互修复(焦点路由)

- **日期**:2026-08-26
- **状态**:修复已完成并通过验证,已作为单独提交保存在本地 git,**未推送**。

### 问题

"让内置浏览器同时可以作为真正浏览器使用"(地址栏导航、工具栏按钮、标签条)在 Windows 上交互不可用:点击按钮无反应、地址栏无法输入。经真机探针(真实系统鼠标/键盘事件)定位:

1. **`before-input-event` 只触发键盘事件**——此前用它检测鼠标点击是探针误判;修正后用 `input-event` + DOM title 变化实测:**真实鼠标点击能到达工具栏 view**,DOM 处理器与 IPC 链路本身正常。
2. **真正的问题在键盘焦点路由**:Windows 上键盘输入只派发给**有焦点的 webContents**,而窗口重新获得焦点(alt-tab、点击)时 Electron **不会自动恢复任何 view 的焦点**(electron#28163)——最后一个 `addChildView` 的 view 抢占焦点。插件里页面 view 抢走焦点后,点击地址栏无法聚焦,键盘输入全部进页面,表现为"UI 不能正常使用"。

### 修复(host-main.ts)

| # | 问题 | 修复 |
|---|---|---|
| 1 | 键盘输入只进有焦点的 view,页面 view 抢占焦点 | 新增 `wireFocusRouting()`:任何 view 收到 `input-event` mouseDown 即 `webContents.focus()`——**点击地址栏 → 焦点切到工具栏 → 可输入网址;点击页面 → 焦点切回页面** |
| 2 | 窗口重新聚焦时不恢复 view 焦点 | `win.on('focus')` 恢复**上次点击的 view**(`lastFocusedViewId`,工具栏用哨兵 key),回退到可见页面 view |
| 3 | 工具栏 view 不在 `win.views` 里 | 定义 `TOOLBAR_FOCUS` 哨兵区分工具栏/页面焦点目标 |

### 验证

- 真机探针(hit2/hit3):真实 OS 点击到达工具栏 view(`input-event mouseDown`)、DOM mousedown 触发;焦点路由生效(点击工具栏 → `toolbar.isFocused()=true`,点击页面 → `page.isFocused()=true`)。
- `tsc --noEmit` 零错误;`node --test tests/*.test.mjs` **21 项**全部通过。
- 版本号未 bump。七轮合计 7 个提交未推送。

---

## 0.1.16 发布(2026-08-26)

bump `0.1.15 → 0.1.16`,将第一至第七轮全部修复随版本发布(本地 11 个提交,origin/master 自 `9ffe5d6` 起):

- **第一轮**:安全与健壮性修复(详见上文)
- **第二轮**:功能补全 + 测试 + CI(详见上文)
- **第三轮**:对标 browser-bridge 的功能 + 审查修复(详见上文)
- **第四轮**:DSH 0.1.1-rc.2 对齐 + 复查修复(详见上文)
- **第五轮**:`available()` 无副作用探测(electron 44 懒下载)+ flushAuth 构建修复
- **第六轮**:Windows RPC 握手 token env 兜底;switch/close_tab 跨 session 定位 + closeTab 不再假成功
- **第七轮**:工具栏焦点路由——点击聚焦目标 view,地址栏可输入,窗口 refocus 恢复上次 view

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。tag `v0.1.16`。

---

# 第八轮:DSH Desktop 宿主 Electron 复用(2026-08-27)

## 症状与根因

- **症状**:在 DSH Desktop(基于 Electron 43 宿主,`desktop` profile)装好插件后,调用 `browser_*` 工具直接报 `cannot locate the Electron binary`。安装插件不带来 electron(optional peer,`dependencies` 为空),`ELECTRON_PATH` 未设置,desktop / web / profiles 的 `node_modules` 均无 electron 包——共享浏览器窗口永远起不来。
- **根因**:插件自托管模式需要可启动的 Electron 二进制,而 `resolveElectronPath()` 只查 peer 依赖 / `ELECTRON_PATH` / DSH 锚点与 pnpm store。DSH Desktop 宿主本身基于 Electron 运行,宿主二进制就在本机,却从未被利用;报错示例 `--profile web` 对 DSH Desktop 用户还有误导。

## 修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | 插件运行在 Electron 进程内(DSH Desktop 主进程)时仍去找 peer 依赖 | `resolveElectronPath()` 第一步:检测 `process.versions.electron`,是则直接复用 `process.execPath` 宿主二进制——零额外安装,且不可能缺失(我们正运行在它上面) |
| 2 | DSH Desktop 把插件跑在 Electron 主进程的**子 Node 进程**时,第 1 步不生效,依旧找不到二进制 | 新增进程祖先树回退(最后手段):向上扫描父进程可执行文件,命中 Electron 二进制(名字含 `electron`,或旁有 `resources/electron.asar`/`app.asar`/`default_app.asar`)即复用;POSIX 走 `/proc`,Windows 走 PowerShell CIM,仅在其它路径全部落空时才执行,不影响正常路径 |
| 3 | 报错示例 `--profile web` 对 DSH Desktop 用户有误导 | 报错改为按当前 profile 动态提示(`<your-profile>`,并注明 DSH Desktop 的 profile 是 `desktop`) |
| 4 | 文档未说明"何时需要 electron" | 环境要求 / FAQ / 架构 / README 同步:DSH Desktop 零安装;纯 `dsh web` 自托管才需要 `dsh plugin --profile <profile> add electron` 或 `ELECTRON_PATH`(44+ 懒下载可先 `npx install-electron`) |
| 5 | CI 类型检查失败(electron 是 optional peer,CI 无该包,走 shim 类型;第七轮焦点路由新增的 API 未入 shim) | `electron-shim.d.ts` 补齐:`WebContents.focus()`、`WebContents.on('input-event')`、`BrowserWindow.on('focus')`——无 electron 包环境 `tsc` 同样零错误 |

## 验证

- `tsc --noEmit` 零错误(无 electron 包环境即 CI 环境同样零错误);构建通过。
- `node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.17 发布(2026-08-27)

bump `0.1.16 → 0.1.17`,将第八轮 DSH Desktop 宿主 Electron 复用修复随版本发布:

- **第八轮**:插件运行在 Electron 进程内直接复用宿主二进制;插件跑在宿主子 Node 进程时沿进程祖先树找到宿主 Electron 兜底(Windows 用 PowerShell CIM,仅最后手段)——DSH Desktop **零安装开箱可用**;报错按当前 profile 动态提示;补齐 electron shim(`WebContents.focus()` / `on('input-event')` / `BrowserWindow.on('focus')`)修复无 electron 包环境(CI)的类型检查;文档与 CHANGELOG 同步。

**验证**:`tsc` 构建零错误(有无 electron 包两种环境);`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第九轮:electron 改为必装依赖(2026-08-27)

## 动机

issue #4 报告者的核心诉求是「装完插件即可用」:此前 electron 是 optional peer,安装插件不会自动带来 electron 包,DSH Desktop 之外(纯 `dsh web` 自托管)的用户仍需手动 `add electron`。本轮按报告者建议 ① 的 A 分支,把 electron 从 optional peer 改为**真实依赖**。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | `package.json`:`electron` 从 `peerDependencies`(+ `peerDependenciesMeta.optional`)移入 `dependencies`(`>= 30.0.0`),删除 `peerDependenciesMeta` | 安装插件即自动带上 electron 包;electron 44+ 无 postinstall,二进制首次使用懒下载,安装不增重 |
| 2 | `remote-host.ts` 注释与报错措辞同步 | 定位顺序 ③ 改为「随插件安装的 electron 包」;报错区分新旧安装(新装自带 electron,旧装仍可 `dsh plugin --profile <profile> add electron`) |
| 3 | `electron-shim.d.ts` 注释同步 | electron 现在是运行时依赖,shim 仍保留(供独立 typecheck src/ 时自洽) |
| 4 | 文档同步(README 中英、user-guide、architecture、CHANGELOG) | 「环境要求」改为必装依赖;定位顺序、FAQ、已知限制同步 |

## 说明

- **DSH Desktop 行为不变**:依旧优先复用宿主二进制(步骤 0/②),随包安装的 electron 仅作后备——安装体积变重是换取「装完即可用」的代价,符合报告者建议。
- **CI 影响**:electron 成为 dependencies 后,CI 的 `npm install` 会装上 electron 包(44+ 无 postinstall,不下载二进制),`tsc` 将使用真实 electron 类型(shim 同步保留,双环境仍零错误)。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);构建通过。
- `node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.18 发布(2026-08-27)

bump `0.1.17 → 0.1.18`,将第九轮「electron 改为必装依赖」随版本发布:

- **第九轮**:electron 从 optional peer 移入 `dependencies`,安装插件即自动带上 electron 包——纯 `dsh web` 自托管开箱可用,不再需要手动 `add electron`;DSH Desktop 依旧优先复用宿主二进制;文档、报错与 shim 注释同步。

**验证**:`tsc` 构建零错误(有/无 electron 包两种环境);`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第十轮:DSH-Store 兼容性声明(2026-08-27)

## 背景

DSH STORE 自动化(AI-Scarlett/DSH-Store #243)固定 Commit 检查发现:`dsh-builtin-browser` 对官方最新 3 个 DSH 版本(`0.1.0-rc.8` / `0.1.1-rc.1` / `0.1.1-rc.2`)没有任何 compatible 的 `dshReleases` 记录 → 触发 `DSH_LATEST_THREE_COMPATIBILITY_HOLD`,插件被临时下架。仅写宽泛范围不算安装证据,必须逐版本声明。

## 改动

`package.json` 新增 `dsh.compatibility`(参照已收录插件 `dsh-vision` 的 schema):

- `dsh`: `>=0.1.1-rc.1 <0.2.0`(覆盖两条 compatible 声明);
- `profiles`: `["web", "desktop"]`;
- `dshReleases`:
  - `0.1.1-rc.2`: `compatible`(peer 对齐 `^0.1.1-rc.2`、CI 全绿、真实 DSH E2E 验证);
  - `0.1.1-rc.1`: `compatible`(真实 DSH `0.1.1-rc.1` profile-boot E2E 实测通过:open→navigate→snapshot 全链路);
  - `0.1.0-rc.8`: `unknown`(未实测,不宣称兼容)。

目的:恢复 DSH STORE 收录。推送后自动化每 8 小时复检,确定性 blocker 清除后自动更新/关闭 issue #243。

## 验证

- `tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.19 发布(2026-08-27)

bump `0.1.18 → 0.1.19`,将第十轮「DSH-Store 兼容性声明」随版本发布(tag `v0.1.19`)。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第十一轮:自托管浏览器宿主崩溃后的会话自愈(2026-08-27)

## 背景

issue #5 报告:自托管模式下 DSH 重启 / 会话 checkpoint 恢复后,`browser_*` 工具间歇性报 `dsh-builtin-browser: browser host is not running`,且恢复不自动。典型半死态:`browser_session` / `browser_list_tabs` 能返回会话与标签,但 `browser_content` 超时或 `browser_open` 直接拒绝;手动 `browser_reset_session` 或再 `browser_open` 一次才恢复。

## 根因

`DeferredRemoteView.materializeOnce()` 把物化后的 `RemoteView` **永久缓存**,而 `RemoteView` 硬引用创建它的 `ElectronChildClient`。浏览器子进程一死(DSH 重启 → 父进程 socket 关闭 → 子进程 `app.exit(0)`;或崩溃),`onChildExit` 虽然重置了宿主(下次可起新子进程),但**已物化的视图句柄仍指向死掉的 client** → 之后每次调用都命中 `call()` 的 `dead` 检查,永远报 "browser host is not running"。会话元数据(session id / tab)仍在 → 半死态;只有新建会话(新视图句柄)才会重新物化 → 手动 reset/open 后"恢复"。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | `remote-host.ts` 新增 `HostGoneError` 标记错误 | `fail()` 与 `call()` 的 dead 检查、`ensureView` 的 host 缺失全部标记为 host-gone,与页面级错误区分 |
| 2 | `DeferredRemoteView` 新增 `withRecovery`:宿主已死时丢弃物化缓存 → 对新子进程重建视图 → **重试该操作恰好一次** | 存活会话在宿主死亡后的**第一次调用**即自动拉起新宿主并重试,不再永久报 "browser host is not running";页面级错误不触发重建 |
| 3 | `ElectronChildClient` 支持注入 spawn 可执行文件(测试缝) | 默认行为不变(`resolveElectronPath()`);供无 Electron 环境的集成测试使用 |
| 4 | 子进程意外退出时父侧输出一条日志 | 可观测性:宿主"已死 / 将重启"一目了然 |
| 5 | 新增 `tests/remote-host-recovery.test.mjs` + `tests/fixtures/fake-host-child.mjs` | 用纯 Node 的假子进程(与 host-main.js 同协议)实测:同一视图句柄在子进程崩溃后自动重启并重试成功——旧代码下该句柄会永久失败 |
| 6 | 文档同步(README 中英、user-guide、architecture) | 「崩溃后旧会话失效需 reset 重建」改为「崩溃后会话自动重建,仅页面状态丢失」 |

## 说明

- **未采用**把浏览器子进程改成 DSH 服务受管子进程(生命周期随 DSH 启停)——那是 DSH 宿主层的架构职责,不在插件能力内;插件的等价保障是:父进程断开时子进程自动退出(已有,不留孤儿),宿主死后会话在下次调用自动重建。
- **未加心跳/看门狗**:子进程事件循环被卡死(RPC 无响应)与"进程已死"是两种情形;本次修复覆盖"进程已死"这一明确缺陷。卡死场景由 provider 的 withTimeout + terminateExecution 打断兜底。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);
- `node --test tests/*.test.mjs` **22 项全部通过**(新增 1 项回归测试);
- 回归测试实测日志链路:`__die` → ECONNRESET → "browser host gone; will restart on next use" → 重新拉起 → 重试成功。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

# 第十二轮:resolveElectronPath 排除打包应用(2026-08-27)

## 背景

issue #6 报告:0.1.19 在 DSH Desktop(打包的 Electron 应用)上 `browser_*` 报 `browser host exited (code=0)`。`resolveElectronPath()` 能找到"某个 electron",但选中的是**打包的宿主应用 exe**——spawn 它不会按脚本参数拉起,而是启动第二个 DSH Desktop 实例 → 命中单实例锁 → 秒退 code=0,报错完全不指向根因。

## 根因(三层,报告者已定位)

1. **layer 0 抢跑**:插件运行在 DSH Desktop 主进程内,`process.versions.electron` 已设置 → 直接返回 `process.execPath` = 打包的 DSH Desktop.exe;
2. **layer 1 在 Electron 主进程内失效**:`require('electron')` 解析为内置 API 模块(非 npm 包路径),bundled 探测永不命中;
3. **layer 4 同样选错**:`isElectronBinary()` 把 `resources/app.asar` 存在即判定为 electron → 祖先树里的 DSH Desktop.exe 被当作可复用二进制。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | 新增 `isBareElectron()`:旁有 `resources/app.asar` 即**打包应用**,不可按脚本参数拉起,一律排除 | 裸 electron(dev 模式 `electron.exe`、`resources/electron.asar`/`default_app.asar` 而无 `app.asar`)才可 spawn |
| 2 | layer 3(当前进程复用)与 layer 4(祖先树)都改为**仅裸 Electron** | DSH Desktop.exe 被正确跳过,不再秒退 |
| 3 | layer 0 改为**bundled 纯文件系统探测**(`bundledElectronBinary()`),置于最优先 | 不依赖 `require` 语义(主进程内解析为内置模块)、不触发 electron 44+ 懒下载(probe 保持无副作用);覆盖普通 node_modules 布局 + pnpm store(`node_modules/.pnpm` 与 `.pnpm` 两种路径) |
| 4 | 定位顺序重排:bundled → `ELECTRON_PATH` → 锚点最新者 → 当前进程裸宿主 → 祖先树裸宿主 | 打包 DSH Desktop 的正确路径是随插件安装的 electron 44 二进制;dist 缺失时给出明确报错(提示 `npx install-electron` / `ELECTRON_PATH`),不再 silent 秒退 |
| 5 | 新增 `internals` 测试钩子(镜像 tool-browser 惯例)+ `tests/electron-resolution.test.mjs` | 打包应用(含名为 electron.exe 但带 app.asar 者)一律 false;裸 electron 为 true |
| 6 | 文档同步(README 中英、user-guide、architecture) | 定位顺序更新 + 「打包应用不参与复用」说明 |

## 说明

- **DSH Desktop 行为变化**:不再复用宿主打包 exe(那是 #4 修复在打包宿主上的漏洞);0.1.18+ 插件自带 electron 包,优先用它的 dist 二进制——首次使用需触发 44+ 懒下载(`npx install-electron` 或首次 require),报错已给出指引。
- **dev 宿主不受影响**:裸 electron 的 dev 宿主(如 `electron .` 的开发环境)仍走 layer 3/4 复用宿主二进制,零安装。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);
- `node --test tests/*.test.mjs` **23 项全部通过**(新增 1 项打包判定回归测试);
- 本机实测:`resolveElectronPath()` 返回 `node_modules/electron/dist/electron.exe`(bundled 优先,非 `process.execPath`);`isBareElectron(node.exe)` = false。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

## 第二次全面复审加固(2026-08-27)

对第十一、十二轮改动换角度重审(并发时序 / 跨平台 / 子进程侧),发现并修复第一轮审查漏掉的问题:

| # | 问题 | 修复 |
|---|---|---|
| 1 | **并发恢复双重建竞态**:child 死时同一句柄上有两个并发 op,两个 catch 各自重建 → 对新 child 发两次 `createView(同 id)` → host-main 覆盖 map 并再挂一个 WebContentsView → 第一个视图泄漏(堆叠、不可销毁) | host-main 的 `createView` 幂等化:同 id 已存在直接回 ok,双重建收敛到同一视图 |
| 2 | **isBareElectron 在 macOS 上失效**:resources 目录检查用 `dirname(exe)/resources`,而 macOS bundle 的资源在 `Contents/Resources` → macOS dev 宿主被误判为非裸 electron,宿主复用失效 | darwin 检查 `Contents/Resources`;打包判定扩展到解包 `app` 目录;「无 resources 目录」排除 portable(全平台一致,测试平台无关) |
| 3 | **anchors 探测在 Electron 主进程内可返回内置名** `require.resolve('electron')` → `'electron'`(非路径),`electronExeBeside` 退化为检查 CWD 相对路径 | 加 `isAbsolute` 守卫,非绝对路径一律跳过 |
| 4 | **dispose 期间 in-flight 重建可 spawn 僵尸 child** | `ensureView` 加 disposed 守卫,disposed 后直接抛 host-gone |
| 5 | 新增测试:解包 `app` 目录的打包应用判定;既有打包/裸/portable 断言保持全平台一致 | |

**验证**:`node --test tests/*.test.mjs` **24 项全部通过**;lib(src+host-main)重建同步;本机实测解析行为不变(bundled 优先、node.exe 非 bare)。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

# 项目整体交叉复审(2026-08-27)

超出两份 issue 的范围,对整个项目做系统性重审:provider.ts 全部 2167 行、tool-browser 工具层(会话/白名单/参数)、browser seam(runtime.ts + types.ts)、provider↔host-main 协议逐字段比对、错误流。结论:协议两端 10 个 op 的消息形状完全匹配(含 hello 认证与 userAction 单行通知),tool 层的会话去重(pendingOpens)与 agent 绑定生命周期正确,seam 的 provider 选择语义与 close() 的容错吞没符合契约。

## 发现并修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | **dispose() vs start() 僵尸 child 竞态**(第二次复审的 disposed 守卫只挡住了 ensureView 入口):恢复路径会在 dispose 清空状态后重新进入 `ready()` → `start()` 从 listen 挂起点恢复,新建 server 并 **spawn 出一个没人会 kill 的 electron child**(`onChildExit` 在 disposed 时提前返回,`dispose()` 又已跑完) | `ready()` 入口 disposed 快速失败;`start()` 在 spawn 完成后复检 disposed 并完整自清理(kill child + close server);`ensureView` 在 `ready()` 之后复检 disposed |
| 2 | **pendingSocket 泄漏**:三处(onChildExit / ready 失败清理 / dispose)都只把 `pendingSocket` 置 undefined,不 destroy | 统一改为 `destroy()` 后再置空 |
| 3 | 新增回归测试:dispose 后的宿主拒绝操作且不再 spawn(旧守卫下第一次调用会真实拉起 child 并留下僵尸窗口) | `tests/remote-host-recovery.test.mjs` 新增 dispose 快速失败用例 |

## 确认无问题(交叉审查覆盖面)

- **协议比对**:客户端 `command/capture/download/flushAuth/restoreAuth/userActionError/groupView/showView/destroyView/createView` 与 host-main 各 case 的字段读取逐一匹配;hello 认证前命令排队、乱序 hello 拒绝、2 秒 token 等待兜底均正确;
- **生命周期**:`ready()` 失败自清理(promise 身份校验防误杀新启动)、`onChildExit` 保留 views map(配合 #5 自愈)、`kill()` 幂等;
- **withRecovery 并发**:双 catch 交错最多产生两次 createView(子进程幂等收敛),重试有界;
- **tool 层**:每 context 状态隔离、`assertAllowed` 白名单、`browser_restrict` 自身始终放行、history 脱敏;
- **seam**:选择语义无注册顺序依赖,`close()` 对四类 provider 缺失错误吞没为 no-op。

**验证**:`node --test tests/*.test.mjs` **25 项全部通过**;`tsc --noEmit` 有/无 electron 包两种环境零错误;lib 重建同步。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

## 0.1.20 发布(2026-08-27)

bump `0.1.19 → 0.1.20`,将第十一轮(issue #5 会话自愈)、第十二轮(issue #6 打包应用排除)与三轮审查加固随版本发布(tag `v0.1.20`)。README 中英同步:更新记录新增三行、Electron 定位顺序与环境要求与修复后的代码对齐(打包宿主不复用、bundled 优先、ELECTRON_PATH 最优先)、验证版本表 bump 0.1.20。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**。

---

## 第十三轮(2026-08-28,issue #7 macOS 输入框无法键入)

**根因**:0.1.16 引入的 `4a13e20 fix(host): route keyboard focus to the clicked view on Windows` 把 Windows 专属 workaround(`wireFocusRouting` mousedown 焦点引导 + 窗口 `focus` 时恢复上次视图焦点,针对 electron#28163)无平台判断地应用到所有平台。macOS/Linux 原生会把键盘输入路由到被点击的视图,在 mousedown 的 `input-event` 里强制 `webContents.focus()` 反而与原生 click-to-focus 打架,页面输入框收不到键入字符。0.1.15(无此代码)正常、0.1.16+ 异常,与报告者降级 0.1.15 即恢复完全吻合。

**修复**:两处 Windows 专属焦点逻辑加 `process.platform === 'win32'` 门——非 Windows 平台恢复 0.1.15 的原生行为,Windows 保留 workaround(修复 #6 期间引入的工具栏/页面点击聚焦行为不变)。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**;lib 重建同步。

**状态**:已改未提交,未 bump 版本、未发布(发布时 bump)。

---

## 第十四轮(2026-08-28,issue #8 window.open/target=_blank 覆盖当前视图致 403)

**根因**:`setWindowOpenHandler` 把所有 HTTP(S) 弹窗直接 `loadURL` 到当前视图并 deny——原页面被覆盖、opener 上下文丢失,依赖新窗口携带 token/referer 的页面(门户「工作台」类跳转)被后端判无权限返回 403。报告者定位准确。

**修复**(采纳报告者方案 + 一个防御分支):HTTP(S) 弹窗改为 `sendUserAction({ type: 'newTab', windowId, url })`——父进程 provider 的 newTab 动作在同一会话窗口建新标签、导航并计入会话历史,原页面与 opener 上下文保留;新标签成为活动标签,agent 的 snapshot 自然跟随。未分组的共享窗口视图(无会话归属,防御路径)保留旧的 loadURL 行为避免退化。非 HTTP(S) 弹窗(OAuth/mailto/自定义协议)仍放行系统处理。附带修正:旧 loadURL 路径绕过父进程历史记录,新路径走 `openUrl` 正常记账。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**(父侧 newTab user-action 已有回归覆盖);lib 重建同步;README 中英弹窗行为描述同步。

**状态**:已改未提交(#7 + #8 两轮),未 bump 版本、未发布(发布时 bump)。

---

## 0.1.21 发布(2026-08-28)

bump `0.1.20 → 0.1.21`,将第十三轮(issue #7 macOS/Linux 输入框无法键入)与第十四轮(issue #8 window.open/target=_blank 覆盖当前视图)随版本发布(tag `v0.1.21`)。README 中英同步:更新记录新增三行、验证版本表 bump 0.1.21、弹窗行为描述与修复后的代码对齐。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**。
