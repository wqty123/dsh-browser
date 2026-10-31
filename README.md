<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

<h3 align="center">为 DeepSeek Harness 打造的<b>共享真实浏览器</b>插件</h3>

<h4 align="center">agent 驱动一个真实、可见、可随时接管的浏览器——人与 agent 操作的是<b>同一个页面</b>。</h4>

## 这是什么

- **真实浏览器,不是转播**:桌面端优先驱动官方侧栏;侧栏不可用时用插件自托管的窗口;也可以在设置里换成你本机的 **Chrome / Edge**。
- **人机同页**:agent 看到和操作的,与你屏幕上是同一个页面,随时可以接手。
- **装完即用**:`dsh_browser_*` 下 **35 个工具**——打开、读取、点击、填表、截图、下载、登录态,不需要额外配置。
- **按任务隔离**:每个任务自己的标签与历史,互不串扰。

## 安装

两端是两份独立安装,**更新一端不会带上另一端**。

更新已装版本要两步(DSH 0.2.1-alpha.2 起对已装包再 `add` 会报 `already-installed`):

```sh
dsh plugin --profile <profile> remove dsh-builtin-browser
dsh plugin --profile <profile> add dsh-builtin-browser@0.5.2
```

### 桌面端

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

要让插件驱动**官方侧栏**里那个浏览器面板,还需在桌面端**自己的安装目录**里装一条 bridge(可选;不装则用自托管窗口):

```sh
node desktop-bridge/install.mjs "<DSH Desktop 安装目录>" --restart
# 或双击 desktop-bridge/install-and-start.cmd
```

不要在桌面端运行中手工安装:归档被占用,`rename` 会以 `EBUSY` 失败。桌面端升级后 bridge 会失效(`bridge-status` 报 `stale`),重跑同一条命令即可修复。

### Web 端(`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

Web 端没有侧栏也没有 bridge:插件自托管一个独立窗口(标题 `dsh-browser`),自带地址栏、前进后退刷新与标签条,可以直接当浏览器用。

> Electron 二进制通常由安装脚本准备。宿主使用 `strict-dep-builds` 时需先批准本插件的构建脚本;跳过了可在 profile 目录执行 `npx --no dsh-browser-install-electron` 手动准备。详见[用户指南](docs/user-guide.md)。

### 装好之后

```
帮我打开 https://example.com，把主要内容用中文总结一下。
```

## 载体:自动选择,也可指定

| 载体 | 何时使用 |
| --- | --- |
| 桌面侧栏 | 外壳支持可驱动的 `<webview>` 且已装 bridge(默认优先) |
| 自托管窗口 | 侧栏不可用或未装 bridge;Web 端总是这一种 |
| 本机 Chrome / Edge | 设置里显式指定 |

侧栏原本有两种"要人先动手"的情况——列没打开、会话不在前台。0.5.2 起都由插件自己处理:没有展开就展开,会话不在前台就请求外壳显示它。取舍与边界见[已知限制](docs/limitations.md)。

## 工具(`dsh_browser_*`,35 个)

| 组 | 工具 |
| --- | --- |
| 打开与导航 | `open` `back` `forward` `refresh` `list_tabs` `switch_tab` `close_tab` |
| 读页面 | `snapshot` `a11y` `content` `scrape` `screenshot` `challenge` |
| 操作 | `click` `click_sequence` `type` `key` `scroll` `execute` |
| 表单 | `fill` `set_value` `clear` `check` `select` `get_value` |
| 会话 | `session` `reset` `reset_session` `restrict` `auth` |
| 记录 | `history` `visited` `replay` |
| 其它 | `wait` `download` |

参数、输出与示例见[工具参考](docs/tool-reference.md)。

`click_sequence`(0.5.2 新增)一次调用打一串坐标点击,用于 canvas 页面:那些页面不采信脚本派发的 `MouseEvent`,只认真实输入。

## 远程观看(默认关闭)

从另一台设备用 DSH 时,浏览器在主机屏幕上。主机在设置里打开 `remoteView.enabled` 后,面板给出一个**只读**画面:2 fps、JPEG 质量 70、等比缩放到 1280×720 内、一帧一请求(慢网络自然降速)、不落盘、不进入聊天或模型上下文。不转发点击/键盘/滚轮。

三个端点,仅同源:`GET /dsh-builtin-browser/browser-view/sessions`、`GET …/browser-view/frame?session=…`、`GET /dsh-builtin-browser/bridge-status`。

画面可能包含验证码、账户信息或登录后内容——打开前请确认这是你要看的页面。

## 文档

| 想知道 | 去哪 |
| --- | --- |
| 安装、配置、日常使用、常见问题 | [用户指南](docs/user-guide.md) |
| 35 个工具的参数、输出与示例 | [工具参考](docs/tool-reference.md) |
| 为什么做成共享真实浏览器 | [为什么做共享真实浏览器](docs/why-browser.md) |
| seam / provider / 工具三层与自托管实现 | [架构说明](docs/architecture.md) |
| 哪些事做不到,以及为什么 | [已知限制](docs/limitations.md) |
| 构建、测试、复验宿主兼容性 | [开发](docs/development.md) |
| 全部文档的分工 | [文档索引](docs/README.md) |

## 更新记录

完整明细(按轮次,含每处修复的原因与证据)见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 日期 | 主题 |
| --- | --- | --- |
| **0.5.2** | 2026-11-01 | 侧栏页面不再需要人先动手:列没打开就展开,会话不在前台就请求外壳显示它并做有界重试;新增批量坐标点击 `click_sequence`;旧 bridge 的无 code 拒绝也按显示状态处理 |
| **0.5.1** | 2026-10-31 | 接管浏览器自己打开的页面:`switch_tab` 与 `open` 落到你正在看的那一页;canvas 检测不再要求元素列表为空;空白页由页面自身 URL 判定 |
| 更早 | — | 见 [CHANGELOG.md](CHANGELOG.md)(`0.5.0` 只打过 tag,未发布到 npm) |

**工具名空间**:0.4.8 起全部工具在 `dsh_browser_*` 下(此前是无前缀的 `browser_*`,与另一个插件相撞,一次重名会让后注册者整套工具消失)。日志里出现 `could not register dsh_browser_xxx` 说明有别的插件占了同名工具——每个工具独立注册,碰撞只影响那一个。自定义提示词里若还写着 `browser_*`,改成 `dsh_browser_*`。

## 感谢

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队——本插件的 seam、工具运行时与插件体系都构建在这个项目之上;感谢 [Cordis](https://github.com/cordiverse/cordis) 提供的插件化基础;以及所有带着完整复现与本地补丁来的报告者,这些修复因此不必靠猜。

## 作者

对插件有意见、或想聊别的插件,欢迎加微信:**`hui13866591135`**(申请时请注明)。

## License

[MIT License](LICENSE)。本项目是 DeepSeek Harness 的社区插件,并非 DeepSeek 官方产品。
