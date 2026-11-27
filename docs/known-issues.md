# 未解决 issue 的排查记录

本文件只记录**已经验证过的事实**，供下一轮从事实起步，避免重复猜测。每条包含：症状、已排除的假设、仍需的数据。

## #140 截图视口几何错误（channel=edge + surface=builtin）

- 症状：`dsh_browser_screenshot()` 返回 189×960 CSS（PNG 378×1920，DPR 2），同一时刻页面 `innerWidth=1029 innerHeight=768 dpr=2`。
- 已排除：
  - **不是 clip 换算错误**。默认截图（无 `maxWidth/maxHeight`）根本不设 `clip`，CDP 直接截当前 surface；`layoutSize()` 只在需要缩放时才读 `Page.getLayoutMetrics`，口径是 `cssContentSize`（宽）+ `cssLayoutViewport`（视口高），单位 CSS 像素。
  - **不是我们的建窗尺寸**。安静模式停放窗口是 `--window-size=1280,800` / `Target.createTarget{newWindow, left:10000, top:0, width:1280, height:800}`，折算不出 189×960。
- 推断：189×960 = 378×1920 设备像素 ÷ DPR 2，说明**被截的 surface 本身**就是一个 378×1920（DIP）的窗口，不是页面所在窗口。
- 需要的数据（来自复现环境）：
  1. `Page.getLayoutMetrics` 原始返回（`cssLayoutViewport` / `cssVisualViewport` / `cssContentSize`）；
  2. `Target.getTargets` 的列表（是否还有第二个 page target）；
  3. `Browser.getWindowForTarget` 的 bounds 与 `Browser.getWindowBounds`；
  4. 截图调用时 `surface=builtin` 解析到的 carrier（`readiness.resolvedCarrier`）。

## #127 多会话交替渲染 dock 触发 React #185

- 症状：启动 20–40 秒后 `Minified React error #185`（Maximum update depth exceeded），每秒数百次，随后渲染进程崩溃；移除本插件后不再复现。
- 已知：issue 里给了调用栈，最后落在 store 的 `publish`。
- 已排除：`plugin.ts` 的 `runtime.setSession(sessionId)` 只是监听器里的转发，不直接 setState。
- 需要的数据：
  1. 完整的 `Runtime.exceptionThrown` 栈（issue 附件里的那一段）；
  2. 两个会话交替时 `setSession` 的调用序列（是否每次 publish 都触发新的订阅回调）。

## #106 Web 端 `channel=本机 Chrome` 仍走桌面桥/侧栏

- 症状：1.0.x 在 Web 端选择本机 Chrome 后不启动独立浏览器窗口，仍走桌面桥/侧栏（0.5.8 正常）。
- 已排除：`chooseCarrier()` 的分支本身正确——`channel === 'chrome' | 'edge'` 走 `detectBrowser` + `SystemBrowserViewHost`，且显式选择优先于 `config.viewHost`。
- 推断：adopt 之后有别的路径重新接管（`config.viewHost` 在 Web 组合里也存在）。
- 需要的数据：
  1. Web 端设置页"诊断"里的 `resolvedCarrier` / `controlledProfile`；
  2. 服务端日志里 `adopt(...)` 的 reason 字符串序列（哪一次采纳覆盖了系统浏览器）。

## #132 双注册带走客户端注册 + 关 Edge 弹 about:blank

- 症状：双注册时设置页没有「浏览器」分节；关闭 Edge 窗口后页面立刻弹回 about:blank。
- 已做（缩小爆炸半径）：`apply()` 里 `watchClientVersion` 与 `applySettingsSection` 各自 try/catch 隔离——任一步失败只丢那一步并打一行 warn，不会再让整个客户端注册一起失败（参考坞此前已是这个模式）。
- 仍需：两次 `__ModuleLoader__.load` 的调用栈与两次注册的 id（判断第二份是同一个包被装了两遍，还是宿主把同一行解析了两次）。

## #131 0.5.8 → 1.0.1 更新失败

- 症状：Windows + DSH 0.2.2-rc.5，从 0.5.8 更新到 1.0.1 失败（附截图）。
- 需要的数据：失败时的原始报错文本（profile 安装日志 / 设置页错误行）。

## #59 Desktop 上 `@deepseek-ai/*` peer 解析不到，四个入口不激活

- 症状：DSH desktop app 里四个入口不激活，宿主 peer 包解析不到。
- 已证伪：**不是发布清单问题**——`npm view dsh-builtin-browser@1.0.1 peerDependencies` 返回的是真实版本范围（`^4.1.0` / `^0.2.2-rc.3` 等），pnpm 打包已正确改写 `workspace:`。
- 推断：问题在 Desktop 应用的运行时解析（插件的 `require('@deepseek-ai/dsh-tools')` 在应用 node_modules 里找不到）。
- 需要的数据：Desktop 上从插件目录执行 `require.resolve` 各 peer 的结果，以及应用侧 node_modules 布局。

## 结论

这 6 条都需要**复现环境的具体读数**才能安全修复；在没有读数的情况下改动核心路径（载体采纳、注册、截图 surface）风险高于收益。建议下一轮先补一个只读诊断入口（在设置页诊断区打印 `resolvedCarrier`、各 peer 的 `require.resolve` 结果、`Page.getLayoutMetrics` 与 target 列表），把这些读数变成用户可一键提供的证据。
