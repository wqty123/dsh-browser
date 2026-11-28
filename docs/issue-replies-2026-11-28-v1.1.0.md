# Issue 回复文案（2026-11-28，1.1.0）

本文件用于发布 **1.1.0** 之后的补充回复。1.0.4 已被废弃（`deprecated: superseded by 1.1.0`），凡是提到版本的回复都应以 1.1.0 为准。

---

## #112 官方 Desktop 0.14.0 不被识别

已修复，随 **1.1.0** 发布（PR #144）。

- 官方 Desktop 0.14.0 的主入口是 `out/main/index.js`（`main: ./out/main/index.js`，且没有 `lib` 目录），此前只认 `lib/main.js`，于是被当成「不是 DSH Desktop」。
- 现在识别规则里增加候选入口：命中 `out/main/index.js` 且声明了 `@deepseek-ai/dsh` 依赖时按官方桌面接受；没有这个依赖的同名外壳仍被拒绝（就是 #62 那类）。
- 识别结果确定后，若该版本没有可用的宿主补丁规格，设置页会明确说明「已识别但当前版本不可打补丁」，而不是显示「未检测到桌面端」。

测试：`tests/desktop-identity.test.mjs`（14 项，含「规则只有一份、随包回退与 JSON 一致」）。

---

## #137 最新版插件导致无法正常退出 DeepSeek 桌面端

已修复，随 **1.1.0** 发布（PR #144）。

- 原因：`will-quit` 阶段 `preventDefault()` 之后再次调用 `app.quit()` 不会重新触发退出流程，退出被永久取消，进程残留且单实例锁不释放。
- 现在退出链路带截止时间：等待在途任务的时间窗结束后无论如何都会退出，单实例锁随之释放。

测试：`tests/automatic-maintenance.test.mjs` 与退出相关的用例。

---

## #125 `will-quit` 中 `preventDefault()` 后重入 `app.quit()` 不生效，退出被永久取消

与 #137 同源、同一个修复，随 **1.1.0** 发布（PR #144）。退出不再依赖「重入 `app.quit()` 能再次触发」，而是由截止时间推进，进程与单实例锁都会释放。

---

## #129 native host 启动器缺 `ELECTRON_RUN_AS_NODE=1`

已修复，随 **1.1.0** 发布（PR #144）。

- 启动器现在以 node 方式运行 Electron（`ELECTRON_RUN_AS_NODE=1`），扩展每次连接 native messaging 不再拉起 GUI 实例、不再抢焦点；
- 注册失败时的错误会带原始命令，便于用管理员终端复现。

---

## #62 第三方壳（dataelement/dsh-desktop）被误判为「未检测到桌面端」

已修复（部分语义调整），随 **1.1.0** 发布（PR #144）。

- 该外壳与本插件支持的 DeepSeek Harness Desktop 同名但入口不同（electron-vite 的 `out/main/index.js`，且没有 `@deepseek-ai/dsh` 依赖）；
- 现在状态检查与安装器会**点名拒绝**并说明原因，不再显示「未检测到桌面端」，也不会改动任何文件；
- 仍不支持给它打补丁——这是刻意保留的边界，因为补丁要改的是 Harness Desktop 的主进程文件。

---

## 已有回复的补充（可选，逐条追加一句）

贴在 #142 / #126 / #131 / #140 / #127 / #132 / #106 / #59 任意已回复的 issue 下：

> 补充说明：该修复已在 **1.1.0** 发布。1.0.4 因发布包缺少 `browser-extension/`（导致 native host 注册失败）已被标记为废弃（`superseded by 1.1.0`），请使用 1.1.0。

---

## Release 说明（可贴到 release / 置顶评论）

`dsh-builtin-browser@1.1.0` 已发布，`latest` 指向它。

- 合并了两个此前拆分的 PR：#143（0.2.3 适配、设置页按载体收敛、引用通道、截图几何、dock 会话切换、幂等注册）与 #144（官方桌面识别、退出不卡死、native host 以 node 运行、第三方壳点名拒绝、宿主补丁 revision 9）；
- 打包链路修复：出包前校验 10 个运行时关键路径（含 `browser-extension/constants.mjs`、`native-host/install.mjs`），`peerDependencies` 写为真实范围（`>=0.2.2-rc.3 <0.3.0`）；
- 1.0.3 / 1.0.4 均已废弃：1.0.3 缺 `browser-extension/`，1.0.4 是过渡版本。
