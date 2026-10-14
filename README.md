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

- **真实页面,而非转播**:页面由**真实的浏览器**承载 —— 桌面端就是官方侧栏里那一个,Web 端是插件拉起的窗口,也可以在设置里改用**你本机的 Chrome / Edge**。用户直接看到 agent 在做什么,随时可以上手接管;
- **人机同页**(桌面端):agent 操作的页面与人看到的是**同一个**页面 —— 不再是一个你看不见的窗口;
- **装好即用**:载体自动选择(桌面端侧重侧栏 → 否则自托管),纯 `dsh web` 不需要任何额外配置;
- **一插件即一套工具**:安装后 agent 自动获得 34 个 `dsh_browser_*` 工具(打开、查看、无障碍树、等待、语义/坐标操作、滚动、回退、批量/单控件填表、按键、结构化提取、截图、下载、登录态管理……)。

一句话:**安装插件 = 获得一个与用户共享、可被 agent 驱动的真实浏览器。**

## 快速开始

```sh
# 从 npm 安装(把 --profile 换成你的 profile:DSH Desktop 用 desktop)
dsh plugin --profile web add dsh-builtin-browser
```

装完直接让 agent 用它 —— 不需要额外配置:

```
帮我打开 https://example.com，把页面上的主要内容用中文总结一下。
```

浏览器窗口(桌面端是侧栏面板)会随第一次调用自动出现;你可以随时在那个窗口里自己操作,agent 会接着往下走。

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

**谁需要更新 0.4.8**:只有名字变了,功能一字未改。**只装这一个浏览器插件的人不必更新**;装了其它浏览器插件(尤其腾讯 BrowserSkill)的人建议更新。详见[用户指南的升级说明](docs/user-guide.md#从-047-升级到-048)。

## 更新记录

完整明细(按轮次,含每处修复的原因与证据)见 [CHANGELOG.md](CHANGELOG.md)。**0.1.16** 起随版本发布(tag `v0.1.16`)。

| 版本 | 日期 | 主题 |
| --- | --- | --- |
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
