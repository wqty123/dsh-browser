# dsh-builtin-browser 文档索引

按"你想做什么"选择入口:

| 目标 | 入口 |
| --- | --- |
| 了解插件为什么存在、与无头方案的区别 | [为什么做共享真实浏览器](why-browser.md) |
| 安装、配置、日常使用与常见问题 | [用户指南](user-guide.md) |
| 全部 25 个工具的参数、输出与示例 | [工具参考](tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](architecture.md) |
| 回到项目首页 | [README](../README.md) |

## 各篇概览

- **[为什么做共享真实浏览器](why-browser.md)** — 定位、设计理念、与 Playwright 等无头方案的对比、边界与取舍。
- **[用户指南](user-guide.md)** — 环境要求、安装、配置项、快速上手、操作纪律、FAQ 与故障排查。
- **[工具参考](tool-reference.md)** — 每个 `browser_*` 工具的参数、输出、守卫与示例。
- **[架构说明](architecture.md)** — 三层结构、`ElectronBrowserViewHost` 接缝、自托管 RPC 子进程、截图通道、Electron 版本选择。
