<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub>中文 · <a href="README.en.md">English</a></sub></p>

<h3 align="center">为 DeepSeek Harness 生态打造的<b>共享真实浏览器</b>插件（装好即用，人机同页）</h3>

<h4 align="center">agent 驱动一个真实、可见、可随时人工接管的浏览器——人与 agent 操作的是<b>同一个页面</b>。</h4>

## 这是什么

`dsh-builtin-browser` 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供浏览器能力:

- **真实页面,而非转播**:页面由**真实的浏览器**承载 —— 桌面端在外壳与 bridge 支持时使用官方侧栏,否则使用插件拉起的窗口;也可以在设置里改用**你本机的 Chrome / Edge**。用户直接看到 agent 在做什么,随时可以上手接管;
- **人机同页**(桌面端):agent 操作的页面与人看到的是**同一个**页面 —— 不再是一个你看不见的窗口;
- **自动选择载体**:桌面侧栏可用时优先侧栏,否则自托管;宿主允许安装脚本且下载可用时,插件会在安装阶段准备 Electron 二进制;
- **一插件即一套工具**:安装后 agent 自动获得 34 个 `dsh_browser_*` 工具(打开、查看、无障碍树、等待、语义/坐标操作、滚动、回退、批量/单控件填表、按键、结构化提取、截图、下载、登录态管理……)。

一句话:**安装插件 = 获得一个与用户共享、可被 agent 驱动的真实浏览器。**

## 快速开始

**先确认你在哪一端** —— 两端是两份独立安装,**更新其中一端不会带上另一端**,浏览器的承载方式也不同。

> **更新已安装的插件是两步**(DSH 0.2.1-alpha.2 起,对已装包再装会直接报 `already-installed`):先 `dsh plugin --profile <profile> remove dsh-builtin-browser`,再 `add` 目标版本。详见[用户指南](docs/user-guide.md#先移除再安装)。

> **0.4.16 正在准备发布**,包含安全、稳定性与桌面 rc.5 侧栏适配修复;现有用户建议在版本发布后更新。插件更新不会更新 DSH 桌面外壳,也不会自动刷新外壳内的 bridge 或已有 `ELECTRON_PATH` 覆盖。先备份,再按[0.4.16 升级说明](docs/user-guide.md#升级到-0416)处理。

### DSH Desktop(桌面端)

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

桌面端在外壳支持可驱动的 `<webview>` 且已安装 bridge 时,驱动**官方侧栏**里那个浏览器面板,agent 操作的就是你在界面上看到的同一页面。侧栏不可驱动时自动使用插件自己的 Electron 窗口。

要让插件驱动侧栏,还需要一条 bridge(它装在**桌面端自己的安装目录**里,不在 profile 中)。**0.5.0 起可以一步完成**:

```sh
# Windows:双击即用,或
desktop-bridge/install-and-start.cmd

# 任意平台:脚本自己关闭 DSH、安装、再启动
node desktop-bridge/install.mjs "<DSH Desktop 安装目录>" --restart
```

`--restart` 由脚本自己关闭桌面端 —— 不要在运行中手工安装:归档被运行中的 Electron 占用,`rename` 会以 `EBUSY` 失败,而"等它退出再装"的守护进程会被一起带走(实测两种拉起方式都如此)。`--restart` 会提示确认,`--yes` 跳过。不带 `--restart` 时脚本仍要求你先关闭桌面端。

> **bridge 是可选项**:不装时自动退回自托管,多出一个独立窗口。**插件或桌面外壳升级后,重跑同一条命令即可修复** —— 桌面端升级会恢复 `app.asar`,桥随之失效,此时 `bridge-status` 报 `stale`。设置在面板顶部可见。载体差异见[已知限制](docs/limitations.md)。

### Web 端(`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

Web 端**没有侧栏,也没有 bridge**:共享浏览器由插件**自托管**拉起一个独立窗口(标题 `dsh-browser`),自带完整工具栏(地址栏 / 后退前进刷新 / 标签条),你可以像用普通浏览器一样直接用它。

> 0.4.16 通常会通过安装脚本准备 Electron 二进制。DSH rc.5 的 pnpm 11.7 使用 `strict-dep-builds`,首次安装可能需在宿主原生插件管理器中批准本插件的构建脚本;插件不会自行修改 `allowBuilds`。使用 `--ignore-scripts` 或明确跳过下载后,可在正确的 profile 目录执行 `npx --no dsh-browser-install-electron` 手动准备(需网络)。若设置了 `ELECTRON_SKIP_BINARY_DOWNLOAD`,该命令也会遵守跳过选择。详见[用户指南](docs/user-guide.md#准备-electron-二进制)。

### 两端通用

完成安装与所需的构建脚本批准后,直接让 agent 用它:

```
帮我打开 https://example.com，把页面上的主要内容用中文总结一下。
```

浏览器窗口会随第一次调用出现;你可以随时在那个窗口里自己操作,agent 会接着往下走。**两端都可以在设置里改用你本机已安装的 Chrome / Edge**,那是行为完全一致的选项。

## 远程观看浏览器(0.5.0 新增)

通过 LAN 或隧道从另一台设备操作 DSH 时,浏览器窗口在主机显示器上,远程看不到 agent 在做什么。0.5.0 补上了只读画面:

**默认关闭。** 主机在设置里打开 `remoteView.enabled` 之后,页面才会提供画面;关闭状态下端点不返回图像、不透露目标信息。**不需要安装或改动其他插件** —— LAN 场景走宿主自己的 web server。

面板是一个悬浮入口(右下角"观看浏览器"),显示当前任务的画面、只读标记、状态与停止按钮。拉帧是**一帧一请求**:显示完上一帧才请求下一帧,慢网络自然降速而不堆积。

| 项目 | 默认值 |
| --- | --- |
| 帧率 | 2 fps(每 500 ms 一帧,上一帧绘制完成才请求) |
| 编码 | JPEG,质量 70,等比缩放到 1280×720 内 |
| 采集 | 被动:不抢焦点、不切标签、不展开窗口、不自动恢复载体 |
| 存储 | 不落盘、不进入聊天或模型上下文 |

**第一版只读**:不转发点击、键盘、滚轮,不提供地址栏或远程切换原生标签。

三个端点,都在 `/dsh-builtin-browser/browser-view/` 下,仅同源可访问:

| 端点 | 用途 |
| --- | --- |
| `GET sessions` | 面板用来取得可观看的会话 id(只有 id,无 URL/标题) |
| `GET frame?session=…` | 一张 JPEG |
| `GET …/bridge-status` | 桌面 bridge 的安装状态 |

画面可能包含验证码、账户信息或登录后内容 —— 打开前请确认这是你要看的页面。

## 文档

| 目标 | 入口 |
| --- | --- |
| 了解插件为什么存在、与无头方案的区别 | [为什么做共享真实浏览器](docs/why-browser.md) |
| 安装、配置、日常使用与常见问题 | [用户指南](docs/user-guide.md) |
| 全部 34 个工具的参数、输出与示例 | [工具参考](docs/tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](docs/architecture.md) |
| 知道哪些事**做不到**、以及为什么 | [已知限制](docs/limitations.md) |
| 构建、测试、复验宿主兼容性 | [开发](docs/development.md) |
| 查看全部文档与 README 分工 | [文档索引](docs/README.md) |

> 环境要求、四种载体的取舍、配置项、操作纪律、故障排查与更新方式都在上面这几篇里 —— **README 只做入口**,细节不在这里重复。

## 工具名空间

本插件占用全局 **`dsh_browser_*`** 名空间(34 个工具)。

**0.4.8 之前是 `browser_*`。** 那个名字是无前缀通用词,与腾讯 BrowserSkill 的 DSH 插件(`@wxg-prc-cpg/browser-skill-dsh-plugin` @0.3.2 的 `browser_session`)直接相撞 —— 而 **DSH 的工具注册是全局且不允许重名**的,后注册的一方直接抛错。对方六个工具因此全部注册失败,表现成"装了但没反应"。

**为什么是我们改:** `browser_*` 这种无前缀的名字不属于任何一方,而一次冲撞的代价**不是"两个插件各用一个",是后注册者整套消失**。把通用名让出来,比让每个用户去改自己的 `node_modules` 合理。腾讯上游也已把它们的六个工具改为 `bsk_*`。

**如果你日志里出现 `could not register dsh_browser_xxx`**:说明有另一个插件占了同一个名字。0.4.8 起每个工具**独立注册**,所以碰撞只影响那一个名字,其余工具照常可用 —— 这条检查就是为了让下次撞名一眼可见,而不是从"插件坏了"开始排查。

从 0.4.7 或更早版本升级时,还需把自定义提示词里的 `browser_*` 改为 `dsh_browser_*`。当前升级建议以 [0.4.16 升级说明](docs/user-guide.md#升级到-0416)为准。

## 更新记录

完整明细(按轮次,含每处修复的原因与证据)见 [CHANGELOG.md](CHANGELOG.md)。**0.1.16** 起随版本发布(tag `v0.1.16`)。

| 版本 | 日期 | 主题 |
| --- | --- | --- |
| **0.5.1** | 2026-10-31 | 接管浏览器自己打开的页面:`switch_tab` 与 `open` 都能落到你正在看的那一页,不再另开一个;canvas 检测不再要求元素列表为空;空白页改由页面自身 URL 判定 |
| **0.5.0** | 2026-10-31 | **远程观看浏览器**(#34)与**主动采集**;桌面 bridge 一键安装/修复(#36);侧栏"面板只是没显示"不再被判为载体损失(#37);canvas 页面与图片链接可见;CDP 会话自动重连 |
| **0.4.16** | 2026-10-31 | 安全与稳定性:并发选页隔离、下载/截图禁止覆盖、bridge 与设置门控加固、载体切换恢复、桌面 rc.5 侧栏适配;Electron `^44.10.0` 与安装阶段二进制准备 |
| **0.4.9**–**0.4.15** | 2026-10-15–19 | 侧栏能力探测与回退、宿主契约对齐、本机 Chrome/Edge 无显示启动与启动移交修复;详见 CHANGELOG |
| **0.4.8** | 2026-10-14 | **工具名空间**:34 个工具移入 `dsh_browser_*`,一个名字被占不再毁掉整套工具 |
| **0.4.7** | 2026-10-12 | 三个"同形"缺陷:载体被写死、宿主死了不换、设置读了不生效;收 #26 的四条建议 |
| **0.4.6** | 2026-10-08 | 跨会话读错侧栏、等待期间误建空白页、升级把浏览器登出 |
| **0.4.5** | 2026-10-06 | 会话串扰的真正根因:面板放置改按会话 id,而非"外壳当前显示谁" |
| **0.4.0**–**0.4.4** | 2026-10-02 | 把"限制"分成真限制与实现限制:`dsh_browser_auth` 三种载体全可用、本机 Chrome/Edge 支持 JPEG、降采样全载体可用;修掉会崩宿主、会静默做错事、会永久挂住的缺陷 |

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队:本插件的 seam、工具运行时与插件体系都构建在这个项目之上。

同时感谢 [Cordis](https://github.com/cordiverse/cordis) 提供的插件化基础,以及所有参与讨论、测试、反馈和插件开发的社区成员 —— 包括带着完整复现与本地补丁来的报告者,他们让这些修复不必靠猜。

## 作者的话

对插件本身有意见或者有想要制作的其他插件,欢迎加我微信来讨论:

**wx:`hui13866591135`**(请在申请好友时注明)

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是 DeepSeek Harness 的社区插件,并非 DeepSeek 官方产品。
