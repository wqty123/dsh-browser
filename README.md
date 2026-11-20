<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

# DeepSeek Harness 浏览器插件

让 DSH 在内置浏览器、桌面侧栏或本机 Chrome、Edge 中打开网页、读取内容、填写表单和下载文件。每个任务有自己的标签页和操作记录。使用可见窗口或桌面侧栏时，你可以接手 Agent 正在操作的页面。

本页功能清单对应 **0.5.8**（适配 DSH 0.2.2-alpha.3：插件路由走宿主会话鉴权）。[更新记录](CHANGELOG.md)

## 快速开始

**先确认你在哪一端** —— 两端是两份独立安装,**更新其中一端不会带上另一端**,浏览器的承载方式也不同。

> **更新已安装的插件是两步**(DSH 0.2.1-alpha.2 起,对已装包再装会直接报 `already-installed`):先 `dsh plugin --profile <profile> remove dsh-builtin-browser`,再 `add` 目标版本。详见[用户指南](docs/user-guide.md#先移除再安装)。

### DSH Desktop(桌面端)

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

桌面端在外壳支持可驱动的 `<webview>` 且已安装 bridge 时,驱动**官方侧栏**里那个浏览器面板,agent 操作的就是你在界面上看到的同一页面。侧栏不可驱动时自动使用插件自己的 Electron 窗口。

侧栏 bridge 安装在**桌面端自己的安装目录**中。Windows 桌面端打开 **设置 → 浏览器**，点击 **安装并重启**，即可完成正常退出、安装、重新启动和桥接连接验证。进行中的任务触发 DSH 自身的退出确认时，由用户决定是否退出。

终端安装方式：保存任务并正常退出 DSH Desktop，包括托盘中的进程，再从插件目录运行：

```sh
node desktop-bridge/install.mjs "<DSH Desktop 安装目录>"
```

完成后启动 DSH Desktop。Windows 用户也可在桌面端退出后运行 `desktop-bridge/install-and-start.cmd`，由它完成安装并启动桌面端。设置按钮由独立维护进程协调，安装器在桌面端退出后校验身份、备份和写入文件。

> **bridge 是可选项**:不装时自动退回自托管,多出一个独立窗口。**插件或桌面外壳升级后,重跑同一条命令即可修复** —— 桌面端升级会恢复 `app.asar`,桥随之失效,此时 `bridge-status` 报 `stale`。设置在面板顶部可见。载体差异见[已知限制](docs/limitations.md)。

### Web 端(`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

Web 端**没有侧栏,也没有 bridge**:共享浏览器由插件**自托管**拉起一个独立窗口(标题 `dsh-browser`),自带完整工具栏(地址栏 / 后退前进刷新 / 标签条),你可以像用普通浏览器一样直接用它。

> 0.5.3 起安装期不下载 Electron、也不带 `postinstall`:运行时要**首次需要时**在后台准备。查看进度和重试都在 **设置 → 浏览器**:准备失败时点「准备内置浏览器」;要在安装阶段提前备好(离线部署 / CI),在该 profile 目录执行 `npx --no dsh-browser-install-electron`(需网络)。详见[用户指南](docs/user-guide.md#准备-electron-二进制)。

### 两端通用

完成安装后,直接让 agent 用它:

```
帮我打开 https://example.com，把页面上的主要内容用中文总结一下。
```

浏览器窗口会随第一次调用出现;你可以随时在那个窗口里自己操作,agent 会接着往下走。**两端都可以在设置里改用你本机已安装的 Chrome / Edge**,那是行为完全一致的选项。

## 选择浏览器

| 选项 | 使用方式 |
| --- | --- |
| 内置浏览器 | 在独立窗口中打开页面，提供地址栏、前进、后退、刷新和标签栏。 |
| DSH 侧栏 | 在支持 Electron `webview` 的桌面端安装桥接组件后，打开网址会自动展开目标会话的侧栏浏览器。连接中断后继续重连所选侧栏。 |
| 本机 Chrome / Edge | 使用插件专用的浏览器配置启动本机 Chrome 或 Edge。 |
| 自动 | 根据本机浏览器和桌面侧栏的可用情况选择。 |

Windows 桌面端 **设置 → 浏览器** 提供安装、修复和重新安装并重启入口，**诊断** 中提供卸载并重启和外部终端命令。界面展示维护阶段，重启后读取持久化结果；安装成功以新进程的桥接连接验证为准。从终端维护时，在桌面端正常退出后从插件目录运行：

~~~sh
node desktop-bridge/install.mjs "<DSH Desktop 安装目录>"
~~~

点击后立即显示准备状态。桌面端退出期间，独立进度窗继续显示安装、启动和连接检查阶段及用时；完成后自动收起。进度窗保持后台显示，关闭它时维护继续运行。

## 浏览器设置

- **环境检查** 显示已找到的 Chrome / Edge、内置运行环境和侧栏桥接状态。自动模式显示实际选择的载体，**诊断** 提供可执行文件路径。
- **安静模式** 保留操作系统的前台窗口和鼠标位置。新启动的浏览器窗口在后台显示，最小化的内置浏览器保持最小化。选择 DSH 侧栏后，打开网址会展示目标会话的侧栏页面，显式切换标签会选择对应的原生标签。
- **展示** 提供侧栏自动展开、随会话关闭浏览器、Agent 光标和远程观看开关。
- **Agent 权限** 控制页面脚本、文件下载和登录状态的读写。
- **高级设置** 提供浏览历史、坐标点击与拖拽许可，以及 Chrome、Edge 和自动模式的登录状态保留和窗口模式。交付表单可以设置工具名、参数模板、失败处理和站点规则，校验后一次保存。

在本机或隔离测试环境中打开 **允许远程观看**，通过 DSH 的观看入口查看会话的只读画面。画面以 JPEG 刷新，最高每秒 2 帧。

## 下载交付

在 **高级设置 → 交付** 中填入已接入 DSH 的上传工具名，并根据该工具的参数设置目标目录。自动交付使用 DSH 原生工具执行器，保留当前任务的工具权限。文件先保存到本地，再交给所选工具，结果中包含本地路径和上传工具的完整返回值。

DSH 侧栏下载使用目标页面所属浏览器会话的登录状态，分段保存文件并在完成后提交到目标位置，保留已有的同名文件。

例如，百度网盘官方 stdio MCP 的上传工具使用下面的参数模板：

```json
{
  "local_file_path": "{path}",
  "remote_path": "/来自：mcp_server/DSH下载"
}
```

`{path}` 会替换为已下载文件的完整路径。`remote_path` 是网盘目标文件夹。工具名采用 DSH 中实际注册的名称，格式为 `mcp__<serverName>__upload_file`。[百度网盘 MCP 参数](https://github.com/baidu-netdisk/mcp)

飞书目标可配置具备文件上传能力的 MCP 工具，参数模板按该工具声明的字段填写。

## 浏览器工具

当前源码注册 51 个工具。表中列出 `dsh_browser_` 后面的名称。

| 用途 | 工具 |
| --- | --- |
| 打开与导航 | `open` `back` `forward` `refresh` `list_tabs` `switch_tab` `close_tab` |
| 读取页面 | `snapshot` `a11y` `content` `scrape` `screenshot` `challenge` |
| 点击与输入 | `click` `click_sequence` `type` `key` `scroll` `drag` `hover` `execute` |
| 填写表单 | `fill` `set_value` `clear` `check` `select` `get_value` |
| 选择与保存文件 | `upload` `download` |
| 执行步骤与核对结果 | `do` `assert` `wait` `wait_for_response` |
| 查看页面状态 | `state` `find` `console` `network` `dialog` |
| 管理会话 | `session` `reset` `reset_session` `restrict` `auth` |
| 查看记录 | `history` `visited` `replay` |
| 网页引用 | `reference_capture` `reference_reveal` `reference_list` |
| 起始页快捷方式 | `shortcuts` |
| 排查问题与查用法 | `doctor` `help` |

## 网页引用的当前支持范围（2026-11-09）

| 能力 | 状态 |
| --- | --- |
| 文字／图片／表格／混合选区的采集、冻结快照与图片资产落盘 | 已实现；真实 Chrome 渲染页面验证跨段选区顺序、真实 PNG 与含合并单元格的表格 |
| 右键文字／图片／表格目标、划选浮动入口（自带 Electron 载体） | 已接入采集与会话交付；单一菜单保留复制／剪切／粘贴／全选 |
| 会话归属、草稿交付、保存成功才提示加入引用 | 已实现：`browser:<uuid>` 与真实 DSH 会话分离，捕获时锁定归属，ACK 要求草稿修订与全部图片资产绑定 |
| 引用卡片、预览、移除、撤销、回到原文 | 引用卡片由宿主 `ui-browser-reference` 插件注册到会话输入框；卡片自带样式表、评论框、6 秒撤销与失败原因提示；不响应的「导入/导出」占位控件已删除。插件自身「引用记录」菜单负责历史记录与定位，设置页不录入对话内容 |
| 模型收到实际文字／图片／表格块 | 宿主 `sendSession` 使用有序提交 seam：`buildContent()` 纯投影，Host 接受后 `commit()` 只消费本次冻结的引用，拒绝/抛错 `rollback()` 保留草稿；成功发送仍保留来源身份。修复已构建并同步到已安装桌面的四个客户端 bundle；未在用户既有会话中发送测试消息 |
| 来源回跳、草稿／排队／重启恢复 | 定位／高亮接口与恢复逻辑有单测；卡片「回到原文」调用 revealer，失败在 dock 内说明原因且提示会自动消失；回复正文里 `dsh-browser-ref:` 链接由宿主 `ui-browser-reference` 的 DOM 桥接激活（安装包自带前端没有该分流），真机验证装饰与点击拦截均生效；重启恢复仍为单测覆盖 |
| 失败可见性、交付一致性 | 捕获拒绝有逐因中文提示（含图片失败、页面跳转、片段过多）；入队失败不再假报成功；非法游标 400、资产竞态 404；交付日志按文件行序折叠，多进程同序号不丢记录；快捷方式按规范化 URL 判重、撤销写回干净记录且失败可重试 |
| 桌面侧栏 guest 的划选／右键入口 | 已接通：bridge 不转发 user action，改由进程内 1.2 秒一次的 CDP 巡检注入浮条并收取 `__dshRefIntents`；真机验证「划选 → 评论 → 添加到对话 → 卡片 → 发送后进入消息上下文」 |
| Chrome／Edge 生产引用入口 | 后续独立批次。独立 MV3 验证工程已通过 Chrome／Edge 各 19 项端到端，但**未接入本插件的生产配对、目标会话选择与原标签定位** |
| 起始页与共享快捷方式 | 已实现并真机验证：空标签页点「添加」可新增；`dsh_browser_shortcuts` / `POST /shortcuts/add` 与侧栏共享同一列表；点快捷方式打开目标网址。宿主 `ui-sidebar-browser`／`ui-sidebar-right` 的重建 bundle 已同步到已安装桌面，修复了部署中 `navigateTabIn` 缺失导致的点击报错；验收期写入的 6 条测试快捷方式已从 live profile 清除（保留 Bing／百度／DeepSeek 三项，原文件有备份） |

> 原生 DSH UI 改动**不会**随本 npm 插件包自动分发：已安装桌面需要把重建的客户端 bundle 复制到 `resources/app/dsh/node_modules/@deepseek-ai/`（必要时还有 profile 的 `node_modules`），bridge 另有独立安装步骤。本机重放脚本、字节级验证、冷启动与端到端真机证据见 `E:/ds 维护以及插件制作/_audit/deployment-review-20261109/`（含第三轮《整体到细节》第 9 节）；客户端 bundle 不在 HMR 监听范围，替换后需重启桌面（验证实例已关闭，下次启动即生效）。

## 文档

- [用户指南](docs/user-guide.md)
- [工具参数与示例](docs/tool-reference.md)
- [工具选择、页面定位与操作步骤](skills/dsh-builtin-browser/SKILL.md)
- [架构说明](docs/architecture.md)
- [兼容性与使用条件](docs/limitations.md)
- [构建和测试](docs/development.md)

本项目是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Cordis](https://github.com/cordiverse/cordis) 的社区插件。感谢提交问题、复现步骤和补丁的贡献者。

作者微信 **hui13866591135** · [MIT 许可](LICENSE)
