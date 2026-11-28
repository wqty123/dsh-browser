# 开放 issue 验收清单（2026-11-28）

状态分三类：**已修**（有测试且 CI 绿）、**已防护/已埋诊断**（改动已进主分支，但根因仍要一份读数才能收口）、**未动**。

| # | 症状 | 已改什么 | 证据 | 还差什么 | 读到之后改哪里 |
|---|---|---|---|---|---|
| #142 | 桥接恢复后设置页仍常驻「桥接维护失败」 | 桥接 `installed` 且 `running` 时不再渲染终态失败（诊断折叠里保留） | `client-panel` 138/138；`70f294f` | — | — |
| #126 | 唯一还原入口是「卸载并重装」（revert 完又装） | 宿主维护任务接受 `uninstall`（revert 即停）+ 设置页「仅移除桥接」按钮 | `automatic-maintenance`、`client-panel` 154/154；`2f164b7` | — | — |
| #131 | 0.5.8 → 1.0.1 更新失败 | `deploy-local --replace`：旧目录改名为 `<target>.backup-<时间戳>`；Junction 安装拒绝替换并提示 | `deploy-manifest` 5/5；`f2510c6`；`docs/development.md`「升级 / 替换已有安装」 | 真实失败现场的原始报错（判断是目录残留还是 npm 解析） | 若是 npm 解析失败，补迁移段与错误提示 |
| #127 | 多会话交替渲染 dock 触发 React #185 | 发布去重：快照未变化不再 `store.set`（`sameFrameState`） | `frame-state` 3/3；`fix(dock)` 提交 | 复现确认：两会话交替渲染后是否仍出现 `Maximum update depth exceeded` | 若仍复现，按 issue 里的 `publish` 栈改 store 订阅 |
| #132 | 双注册带走客户端注册；关 Edge 弹 about:blank | ① 重复注册按上下文拒绝（`apply-guard`）；② `watchClientVersion` / `applySettingsSection` 各自隔离 | `apply-guard` 2/2、`frame-state` 3/3；`fix(client)` 提交 | 两次 `__ModuleLoader__.load` 的栈与注册 id（第二份来自哪） | 若是同包装两遍 → 安装期去重；若是宿主解析两次 → 宿主侧 |
| #59 | Desktop 上 `@deepseek-ai/*` 解析不到，四入口不激活 | 用户机器的诊断区**没有**「未解析 peer」行 → 该安装 peer 解析正常，问题不在这个环境 | runtime status 逐条解析 6 个 host peer，诊断区列出未解析项与错误原文；已证伪"发布清单带 `workspace:^`"（npm 上是真实范围） | `runtime-status` 165/165；`feat(diagnostics)` 提交 | 诊断区里那行未解析 peer 文本 | 若是应用 node_modules 布局问题 → 插件侧改用宿主注入的依赖解析 |
| #140 | Edge builtin 截图 189×960，页面实际 1029×768 | **本次复现并修复**：本机 channel=edge 下截图 231×960 而页面 1254×707（同一文档，洋红背景可见）。原生 capture 描述的是"视图"而非页面布局；现在长宽比与 `Page.getLayoutMetrics` 视口不符时改用 CDP 视口 clip 重截 | `screenshot-geometry` 3/3、`layout-metrics` 3/3、`preview-read-only` 通过 | 宿主半需重启才生效 | 重启后若仍有偏差，看 `Page.getLayoutMetrics` 的 css 值 |
| #106 | Web 端选本机 Chrome 仍走侧栏 | 用户机器诊断显示 `will drive the installed edge` / `will drive the installed chrome`，且未出现「using only the selected DSH sidebar」→ 该环境采纳正常；配置「浏览器扩展」时显示当前载体 CDP 属既定降级 | `adopt()` 记录最近 8 条决策 reason，随状态返回并在诊断区列出 | `runtime-status` 165/165；`feat(diagnostics)` 提交 | 诊断区最后一条 reason 序列 | 末条是「not installed」→ 修检测；末条是「using only the selected DSH sidebar」→ 修 adopt 覆盖顺序 |
| #119 | 「绝不自动解验证码」的前提 | 不改：产品红线 | — | — | — |

## 已修（可直接关闭）

- **#142**、**#126**、**#131**。
- 建议在 PR 合并后关闭，并在关闭评论里附上对应提交与测试名。

## 已防护/已埋诊断（需要一份现场读数才能关闭）

- **#127**（去重已上）、**#132**（拒绝重复注册 + 隔离已上）、**#59**（诊断已上）、**#140**（读数入口已上）、**#106**（采纳历史已上）。

这五条的共同点：修复动作取决于"现场到底发生了什么"，而插件现在能自己报告这件事。用户复现后把对应那一行发出来，就能直接定位到要改的函数。
