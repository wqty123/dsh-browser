# dsh-builtin-browser 文档索引

按"你想做什么"选择入口:

| 目标 | 入口 |
| --- | --- |
| 了解插件为什么存在、与无头方案的区别 | [为什么做共享真实浏览器](why-browser.md) |
| 安装、配置、日常使用与常见问题 | [用户指南](user-guide.md) |
| 全部 34 个工具的参数、输出与示例 | [工具参考](tool-reference.md) |
| 了解 seam / provider / 工具三层与自托管实现 | [架构说明](architecture.md) |
| 知道哪些事**做不到**、以及为什么 | [已知限制](limitations.md) |
| 构建、测试、复验宿主兼容性 | [开发](development.md) |
| 回到项目首页 | [README](../README.md) |

## 各篇概览

- **[为什么做共享真实浏览器](why-browser.md)** —— 定位、设计理念、与 Playwright 等无头方案的对比、边界与取舍。
- **[用户指南](user-guide.md)** —— 环境要求、安装、配置、操作纪律、FAQ、故障排查、验证过的版本、更新方式(两端不同)、以及从 0.4.7 升级的改名说明。
- **[工具参考](tool-reference.md)** —— 每个 `dsh_browser_*` 工具的参数、输出、守卫与示例。
- **[架构说明](architecture.md)** —— 三层结构、`ElectronBrowserViewHost` 接缝、四种载体的分工(桌面侧栏 / 本机 Chrome-Edge / `electronViewHost` / 自托管)、自托管 RPC 子进程、截图通道、Electron 版本选择。
- **[已知限制](limitations.md)** —— 截图、登录态、权限门控、下载路径、载体行为的边界,以及本插件**不提供**的东西。
- **[开发](development.md)** —— 构建与测试命令、代码结构、宿主兼容性复验、peer 范围的 semver 语义。
