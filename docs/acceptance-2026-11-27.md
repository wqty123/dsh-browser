# 验收清单（2026-11-27，DSH 0.2.3-alpha.2 适配版）

这一版解决的是「装得上、跑得对、说真话」三件事，不含 Web 侧栏的存储兼容（见文末“明确未做”）。
安装位置：`%DSH_HOME%\profiles\web\plugins\dsh-builtin-browser`（本机为 `D:\dsh-home`）。
备份位置：同目录旁的 `dsh-builtin-browser.bak-20261127`。

## 零、部署方式（不要手工拷贝目录）

目录链接安装（profile 里的 `link:./plugins/...`）**不会应用 `publishConfig`**：手工拷贝后包里仍是开发态
`exports`（`./client` → `./src/client/index.ts`），宿主会把 TypeScript 源码当客户端包发给浏览器，浏览器执行不了，
插件永远不会调用 `__ModuleLoader__.load`，设置页停在骨架屏并报 `loaded without registering`。

正确的部署命令（构建 + 写入发布态 manifest + 逐项校验 exports）：

```powershell
node tools/deploy-local.mjs                              # 默认装到 $env:DSH_HOME\profiles\web\plugins\dsh-builtin-browser
node tools/deploy-local.mjs --target <目录> --no-build   # 指定目录 / 复用已有构建
```

脚本会输出 `./client = ./lib/client.js (… KB, __ModuleLoader__ envelope)`，并断言每个导出的目标文件都存在。

## 一、重启后才生效

插件代码在 DSH 启动时加载，重启 `dsh web` 那一个进程即可。**不要删 `DSH_HOME`**。
重启后先看设置页能不能正常打开（这一步同时验证 HTTP 路由鉴权）。

## 二、逐项验收（预计 10 分钟）

| # | 操作 | 预期 | 失败时说明什么 |
|---|---|---|---|
| 1 | 打开 **设置 → 浏览器** | 面板正常显示：载体、桥接状态、门控开关 | 仍报 `browser-auth-unavailable` → 鉴权路径不对，回滚 |
| 2 | 侧栏打开一个普通站点（如 example.com） | 页面正常渲染，地址栏、前进后退可用 | 白屏 → 载体或代理问题 |
| 3 | 在页面里**划选一段文字** → 浮条点“引用选中的文字” | 输入框出现引用的引文与胶囊 | 没反应 → 消息通道仍未接通（本次修的就是它） |
| 4 | 发送消息后，点胶囊上的“回到原页面” | 打开来源页并定位/高亮选区 | 打不开 → 引用回流链路问题 |
| 5 | 让 agent `dsh_browser_open` 打开一个地址再 `dsh_browser_snapshot` | 快照里有带编号的可交互元素 | 报载体能力不足 → 看设置页载体选择 |
| 6 | 侧栏打开一个**需要登录态**的站点（如网盘） | 大概率白屏或功能残缺 | **这是已知限制，不是本版回归**，见文末 |

第 3、4 项是本次修复的核心：上一版把网页放进了 DSH 同源，但客户端只认隔离来源的消息，导致引用通道全断；现在两种来源都接受，且仍用 `event.source` 确认是同一个帧。

## 三、隔离状态（本版有意保留的行为）

- 网页仍运行在**隔离来源**（opaque origin）里，读不到 DSH 的本地数据与接口。
- 代价：需要 `localStorage`/`IndexedDB`/`worker` 的站点跑不起来。这是 1.0.1 就有的限制，文档里一直写着。
- 上一版为了让这些站点能跑而放开同源，会让**任意被浏览的网页**获得与 DSH 同等的同源权限（可读同源存储、可带登录态调同源接口）。本版撤回了这一改动。

## 四、明确未做

1. “需要存储的站点也能跑”——正解是给网页**独立来源**（另端口/子域），属于独立设计，未在本版实施。
2. Web 侧栏的其它体验优化（下载交付、远程观看）不在本版范围。

## 五、回滚（30 秒）

```powershell
$p = "$env:DSH_HOME\profiles\web\plugins"
Remove-Item "$p\dsh-builtin-browser" -Recurse -Force
Rename-Item "$p\dsh-builtin-browser.bak-20261127" 'dsh-builtin-browser'
```

然后重启 `dsh web`。回滚后恢复的是上一版（网页可跑、引用断、同源隔离已放开）。

## 六、本版改动摘要（可对照代码审阅）

- `src/client/view/IframePresentation.ts`：消息来源改为「隔离来源或本应用来源」；等不到文档身份回执时按已加载处理，不再把整个载体标记为不可用。
- `assets/browser-policy.mjs`：新增 7 条共用路由常量；`WEB_BROWSER_SANDBOX` 保持隔离（撤回 `allow-same-origin`）。
- `package.json` / `.github/workflows/ci.yml`：`engines.dsh` 回到 `>=0.2.2-rc.3 <0.3.0`，CI 增加 `0.2.2-rc.5` 一条腿。
- `tests/routes-single-source.test.mjs`：路由字面量只允许出现在策略文件里。
- `tests/docs-version-claims.test.mjs`：文档里的版本区间必须等于 manifest，CHANGELOG 除外。
