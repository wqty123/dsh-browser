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

本页功能清单对应 **0.5.7**。[更新记录](CHANGELOG.md)

## 安装

插件在两端各装一份，**互不连带**：更新其中一端不会更新另一端。

| | 桌面端（DeepSeek Harness 桌面应用） | Web 端（`dsh web`） |
| --- | --- | --- |
| 插件配置 | `desktop` | `web`（或你实际使用的 profile） |
| 可用于的载体 | 内置浏览器、DSH 侧栏、本机 Chrome / Edge | 内置浏览器、本机 Chrome / Edge |
| 侧栏桥 | 需要，装在桌面端的安装目录里 | 不需要，Web 端没有侧栏 |
| 更新之后 | 重启桌面端；**桌面端升级过还要重装一次桥** | 重启 `dsh web` 即可 |

~~~sh
dsh plugin --profile desktop add dsh-builtin-browser   # 桌面端
dsh plugin --profile web add dsh-builtin-browser       # Web 端
~~~

已装过时先移除再安装：`dsh plugin --profile <profile> remove dsh-builtin-browser`（DSH 0.2.1-alpha.2 起，对已安装的包直接再装会失败）。

安装后，可以在 DSH 会话里试用下面的任务。

> 帮我打开 https://example.com，提取页面标题和主要内容。

DSH 会准备内置浏览器所需的 Electron。打开 **设置 → 浏览器** 查看进度，准备失败时点击 **准备内置浏览器** 重试。需要提前准备时，可在对应的插件配置目录执行 `npx --no dsh-browser-install-electron`。[用户指南](docs/user-guide.md)

## 选择浏览器

| 选项 | 使用方式 |
| --- | --- |
| 内置浏览器 | 在独立窗口中打开页面，提供地址栏、前进、后退、刷新和标签栏。 |
| DSH 侧栏 | 在支持 Electron `webview` 的桌面端安装桥接组件后使用。 |
| 本机 Chrome / Edge | 使用插件专用的浏览器配置启动本机 Chrome 或 Edge。 |
| 自动 | 根据本机浏览器和桌面侧栏的可用情况选择。 |

使用 **DSH 侧栏** 时，在插件目录运行下面的命令。安装器校验 DSH 安装目录，安装桥接组件后重启桌面端。桌面端升级后，可展开 **设置 → 浏览器 → 诊断** 查看桥接状态，并用同一条命令修复。

~~~sh
node desktop-bridge/install.mjs "<DSH Desktop 安装目录>" --restart
~~~

## 浏览器设置

- **就绪状态** 显示浏览器是否可用。展开 **诊断** 查看浏览器选项、内置运行时和桌面桥接状态。
- **安静模式** 保留当前窗口和标签。新启动的 Chrome 和 Edge 在后台运行，最小化的内置浏览器保持最小化。使用桌面侧栏时，先手动打开目标页，再交给 DSH 操作。
- **展示** 提供侧栏自动展开、随会话关闭浏览器、Agent 光标和远程观看开关。
- **Agent 权限** 控制页面脚本、文件下载和登录状态的读写。
- **高级设置** 提供浏览历史、页面定位方式，以及 Chrome 和 Edge 的登录状态保留和窗口模式。交付表单可以设置工具名、参数模板、失败处理和站点规则，校验后一次保存。

在本机或隔离测试环境中打开 **允许远程观看**，通过 DSH 的观看入口查看会话的只读画面。画面以 JPEG 刷新，最高每秒 2 帧。

## 下载交付

在 **高级设置 → 交付** 中填入已接入 DSH 的上传工具名，并根据该工具的参数设置目标目录。自动交付使用 DSH 原生工具执行器，保留当前任务的工具权限。文件先保存到本地，再交给所选工具，结果中包含本地路径和上传工具的完整返回值。

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

当前源码注册 48 个工具。表中列出 `dsh_browser_` 后面的名称。

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
| 排查问题与查用法 | `doctor` `help` |

## 文档

- [用户指南](docs/user-guide.md)
- [工具参数与示例](docs/tool-reference.md)
- [工具选择、页面定位与操作步骤](skills/dsh-builtin-browser/SKILL.md)
- [架构说明](docs/architecture.md)
- [兼容性与使用条件](docs/limitations.md)
- [构建和测试](docs/development.md)

本项目是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Cordis](https://github.com/cordiverse/cordis) 的社区插件。感谢提交问题、复现步骤和补丁的贡献者。

作者微信 **hui13866591135** · [MIT 许可](LICENSE)
