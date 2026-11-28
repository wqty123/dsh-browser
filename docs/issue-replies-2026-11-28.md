# Issue 回复文案（2026-11-28）

每条都可直接粘贴到对应 issue。末尾「建议」是我对处置方式的建议，不要贴进去。

---

## #142 桥接已恢复但设置页常驻「桥接维护失败」

已修复，随 **1.0.4** 发布。

原因如报告所述：上一次维护的终态 `failed` 记录只在「下一次维护开始」时被覆盖，桥接恢复后没有任何失效路径。现在的行为：

- 桥接处于 `installed` 且 `running` 时，不再渲染这条终态失败；
- 原始记录仍保留在「诊断」折叠区，排查时还能看到；
- 桥接确实不健康时，提示照旧。

回归测试：`tests/client-panel.test.mjs`（138 项，含该场景）。提交见 PR #143。

---

## #126 提供「只移除桥接（不重装）」的单向入口

已实现，随 **1.0.4** 发布。

- 宿主维护任务现在接受 `uninstall` 动作：还原宿主补丁与拆包布局后**立即停止**，不再顺手重装；
- 设置 → 浏览器 → 侧栏浏览器桥接 里新增「仅移除桥接」按钮，与「卸载并重装」并列；
- 文案与入口都只在侧栏载体、且真的检测到 Desktop 安装时出现。

测试：`tests/automatic-maintenance.test.mjs`、`tests/client-panel.test.mjs`。

---

## #131 0.5.8 → 1.0.1 更新失败

针对更新/替换这条路径做了两处改动，随 **1.0.4** 发布。

1. `tools/deploy-local.mjs --replace`：替换前把旧安装目录改名为 `<target>.backup-<时间戳>`，再写新版本，避免覆盖后新旧文件混杂；目录链接（Junction）安装会被拒绝并提示先移除链接。
2. `docs/development.md` 增加「升级 / 替换已有安装」：目录安装用 `--replace`；npm 安装走 DSH 自己的「先移除再安装」。

如果你那次失败的原始报错还在，贴出来我可以确认属于哪一类（目录残留还是 npm 解析）。

---

## #140 截图视口几何错误（channel=edge + surface=builtin）

已定位并修复，随 **1.0.4** 发布。

按报告步骤在本机复现：

| 读数 | 值 |
|---|---|
| 页面自报 | `clientWidth` 1239、`innerWidth` 1254、窗口 1280×800 |
| 修复前截图 | **231×960**（同一文档：把 `body` 背景改成洋红后截图里可见，说明不是截错页面） |
| 修复后截图 | **1239×768**，与页面自身宽度一致 |

根因：默认截图走原生 `capture()`，它描述的是「视图」，而那个视图不一定是页面的布局面（离屏停放的窗口会给出一个很小的 backing surface），于是页面被按 231 宽重排后截下来。现在的规则：

- 原生截图的长宽比与 `Page.getLayoutMetrics` 的视口不符（>5%）时，改用 CDP + 视口 `clip` 重截；
- 形状一致（包括 DPR 2 的 2508×1414 对应 1254×707）时保留原生快照，不重复截。

测试：`tests/screenshot-geometry.test.mjs`（3 项）、`tests/layout-metrics.test.mjs`（3 项）。另外 `dsh_browser_state` 现在会输出 `viewport 1254×707 @1 (window 1280×800)`，便于以后直接对照。

---

## #127 多会话交替渲染 dock 触发 React #185

已修复渲染期的根因，随 **1.0.4** 发布；想请你确认一下是否还复现。

定位过程：`src/client/reference/client/plugin.ts` 的 `onDockProps` 在**每次 dock 渲染时同步调用** `runtime.setSession(自己的会话)`。两个 dock 同时存活（各自被保活的会话）时，A 渲染 → 切到 A → 通知订阅者 → B 重渲染 → 切到 B → 通知 → A 重渲染……形成同步无界循环，正是 `Maximum update depth exceeded`。

修复：

- 会话切换移到微任务里（`queueMicrotask`），渲染期间不再改动它读取的 store；
- 同一 tick 内多次上报只保留最后一次（`src/client/reference/client/session-schedule.ts`），并且「已经生效的会话」不再重复排任务。

测试：`tests/session-schedule.test.mjs`（3 项：一次 tick 只生效一次、重复上报不排任务、跨 tick 仍能切新会话）。运行时 `setSession` 本身对「同一会话」早有短路，两层合起来才把循环切断。

如果 1.0.4 上仍出现 #185，请贴出 `Runtime.exceptionThrown` 的栈（issue 里那份新旧都行），我继续按栈定位。

---

## #132 双注册把客户端注册整批带走 / 关 Edge 窗口后弹回 about:blank

已做两步防护，随 **1.0.4** 发布；根因（第二份注册从哪来）仍需要一份栈。

已改：

1. **设置分节每页只挂载一次**（`src/client/settings/mount-guard.ts`）：成功后置位，重复 `apply` 直接跳过；挂载真失败时不置位，下次仍会重试。此前重复注册同一个 `settings.section` id 会被宿主拒绝，而拒绝发生在本次 `apply` 中途，于是同一批里的其它注册一起丢失（就是「设置页没有浏览器分节」）。
2. **两步注册各自隔离**：`watchClientVersion` 与 `applySettingsSection` 各自 try/catch，一个失败只丢自己。

需要你提供：控制台里两次 `__ModuleLoader__.load` 的调用栈与两次注册的 id。有了它我能判断第二份是「同一个包被装了两遍」还是「宿主把同一行解析了两次」，这两种的修法不同。

---

## #106 1.0.x 在 Web 端不启动独立浏览器窗口（channel=本机 Chrome 仍走侧栏）

在你本机的诊断里**没有复现**，需要一次现场读数。

我核对了 `chooseCarrier()`：`channel === 'chrome' | 'edge'` 会走 `detectBrowser` + `SystemBrowserViewHost`，显式选择优先于 `config.viewHost`，逻辑本身是对的。

你机器上的诊断显示的是：

```
will drive the installed edge (C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe)
will drive the installed chrome (C:\Program Files\Google\Chrome\Application\chrome.exe)
```

没有出现 `using only the selected DSH sidebar` —— 也就是说这台机器上采纳是生效的。「配置的载体=浏览器扩展、当前载体=DSH 独立浏览器（CDP）」是既定降级（扩展未连接时走 CDP），不是走错载体。

**现在加了诊断**：`adopt()` 每次决策都会记录 reason（保留最近 8 条），随 runtime status 返回，并显示在设置页「诊断」区。下次复现时请把最后 2–3 条 reason 贴出来：末条是 `the selected chrome is not installed` 说明检测失败；末条是 `using only the selected DSH sidebar` 说明采纳被侧栏覆盖。两种情况我分别修。

---

## #59 Desktop 上 `@deepseek-ai/*` 解析不到，四个入口不激活

已证伪一个假设，并加了诊断；还需要一条现场读数。

- **不是发布清单问题**：`npm view dsh-builtin-browser@1.0.1 peerDependencies` 返回的是真实版本范围（`^4.1.0` / `^0.2.2-rc.3` 等），pnpm 打包已经改写 `workspace:`；
- **本机（0.2.3-alpha.2 + 桌面端 profile）也不复现**：从安装目录用 `createRequire` 逐个解析 6 个 peer，全部 OK；
- 另外顺带修了一个真实的分发缺陷：手工 `npm pack` 出来的 tarball 会保留 `workspace:^`，现在 `scripts/publish-manifest.mjs` 会改写为 `>=0.2.2-rc.3 <0.3.0`，并由 `scripts/pack.mjs` 在出包前校验（1.0.4 起生效）。

**诊断已加**：runtime status 现在逐个解析 6 个 host peer，未解析的会在设置页「诊断」区列出（包名 + 解析器原文）。请在能复现的机器上贴出那一行——有了它就能确定是应用侧 node_modules 布局问题，还是插件解析路径问题。

---

## #119 「绝不自动解验证码」这个前提本身是错的

（如果要回）这条我们**不改**，说明立场：

这个插件把「人工验证必须由人完成」当作产品红线：遇到 CAPTCHA / 滑块 / 人机校验时，工具会停下来、交还给人，并提供公开回退路径（站点 API、搜索结果、存档），但不会尝试自动求解。理由是这属于平台规则与账号安全的边界，不是可以靠工程手段绕过的东西。相关行为在 1.0.x 保持不变。

---

## 发布说明（可贴在 release 或置顶评论）

`dsh-builtin-browser@1.0.4` 已发布（`latest` 指向它）：

- 修复 1.0.3 的 tarball 缺 `browser-extension/` 导致 `native-host` 注册失败（`ERR_MODULE_NOT_FOUND: browser-extension/constants.mjs`）；1.0.3 已标记为废弃并建议使用 1.0.1 或 1.0.4；
- 出包前校验 10 个运行时关键路径，缺一即拒绝出包；
- tarball 的 `peerDependencies` 不再出现 `workspace:^`；
- 含 #140 截图几何、#127 dock 会话切换、#132 幂等注册、#142 终态失败失效、#126 仅移除桥接等修复。
