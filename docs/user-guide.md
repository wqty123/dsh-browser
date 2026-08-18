# 用户指南

## 环境要求

- DeepSeek Harness(dsh)且安装了 `web` profile
- **Electron 运行时**(可选 peer 依赖):桌面外壳自带;纯 `dsh web` 下插件自动定位 Electron 二进制(建议 ≥ 40,33.x 存在截图合成器缺陷)

## 安装

```sh
# 从 npm 安装(已发布)
dsh plugin --profile web add dsh-builtin-browser

# 或从源码目录(独立仓库,一插件一仓库)
dsh plugin --profile web add <本仓库路径>
```

安装会链接插件、把 `dsh-builtin-browser` 加入 profile 的 bundle 层,并挂载三行:

| 行 | 子路径 | 角色 |
| --- | --- | --- |
| `browser` | `dsh-builtin-browser/browser` | `ctx.browser` 能力 seam(始终挂载) |
| `browser-electron` | `dsh-builtin-browser/browser-electron` | Electron CDP provider |
| `tool-browser` | `dsh-builtin-browser/tool-browser` | `browser_*` 模型侧工具 |

> 没有桌面外壳时插件**自托管**:自己拉起一个标题为 `dsh-browser` 的 Electron 窗口,`browser_*` 工具照常可用。

## 配置

| 行 | 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | 对象 | 必填 | 宿主提供的 `ElectronBrowserViewHost`(通常 `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | 布尔 | `true` | 仅允许 HTTP(S) 导航;`file:`/`data:` 等拒绝 |
| `browser-electron` | `snapshotMaxElements` | 数字 | `60` | 快照最多收录的交互元素数 |
| `browser-electron` | `contentMaxChars` | 数字 | `100000` | 内容抓取默认字符上限 |
| `browser-electron` | `downloadDir` | 字符串 | `~/Downloads` | 限定 `browser_download` 保存路径必须位于该目录内;默认收敛到系统下载目录,可改沙箱目录 |
| `tool-browser` | `timeoutMs` | 数字 | `60000` | 工具协作超时(ms) |
| `tool-browser` | `tabTools` | 布尔 | `true` | 是否注册标签管理工具 |

## 快速上手(给 agent 的提示词示例)

```
1. browser_open 打开 https://example.com
2. 慢站点先 browser_wait(url=…) 等页面就绪,再 browser_snapshot 查看可交互元素
3. 需要填表时用 browser_fill(按 name/label/placeholder 匹配,一次填多个字段)
4. 需要截图确认时用 browser_screenshot(可 savePath 存文件,大页面用 maxWidth 缩小)
5. 需要滚动/回退/按键时用 browser_scroll / browser_back / browser_forward / browser_key
6. 遇到验证码(browser_challenge 或快照标注 CHALLENGE)时,停下请用户处理
7. 每次操作后告知用户你在页面上做了什么
```

## 操作纪律

- **优先用 DOM 语义而非坐标**:表单提交优先 `form.requestSubmit()`;点击优先 `element.click()`;坐标点击是最后手段。
- **选中正确的元素**:页面常有隐藏副本(如移动端按钮),用 `browser_execute` 过滤可见元素(`getBoundingClientRect()` 宽高 > 0、`getComputedStyle` 非 `display:none`),再取坐标。
- **取坐标后立即点击**:中间不要插入其他操作(填表、滚动会移动元素,旧坐标立即失效)。
- **点击前验证命中**:`document.elementFromPoint(x, y)` 确认该坐标确实是目标元素,再执行真实点击。
- **DPR 注意**:CDP 输入使用 CSS 像素;高 DPI 屏上若点击落空,用 `elementFromPoint` 校准,不要盲试坐标。

## 多任务并行

每个 DSH 会话(任务)拥有独立的浏览器会话(独立标签页与历史),并发任务互不干扰:

- `browser_session` 查看本任务的会话与标签;
- `browser_reset_session` 关闭并重建本任务的会话(崩溃或卡死后用它恢复)。

登录态(cookie)为所有任务共享;可用 `browser_auth` 导出/恢复,重启后不丢。

## FAQ

**Q:纯 `dsh web` 能用吗?**
能。插件自托管:自己拉起 Electron 窗口,无需桌面外壳。

**Q:找不到 Electron?**
插件按顺序自动定位:① peer 依赖 `require('electron')` → ② `ELECTRON_PATH` 环境变量 → ③ DSH 锚点与 pnpm 虚拟仓库中版本最新者。都找不到时报清晰错误,可 `dsh plugin --profile web add electron` 或设置 `ELECTRON_PATH`。

**Q:截图失败或挂起?**
确保 Electron ≥ 40(33.x 有合成器缺陷)。自托管截图优先走原生 `capturePage`,多视图/窗口未激活时自动兜底到 CDP。

**Q:浏览器窗口不见了?**
窗口标题为 `dsh-browser`(自托管)。若子进程崩溃会自动重启;重启后旧会话失效,调用 `browser_reset_session` 重建。

**Q:下载报 CORS 错误?**
`browser_download` 在页面上下文内 `fetch`,受同源/CORS 约束;跨域文件请先在同源页面内操作,或直接请求用户提供。仅支持 HTTP(S) URL;`savePath` 必须为绝对路径(配置 `downloadDir` 后限定在该目录内)。

**Q:如何禁止 agent 乱点?**
`browser_restrict` 设置白名单(如只允许 `browser_snapshot`/`browser_content`);传空列表解除。注意它是防误操作的**软护栏**,模型可自行解除,不是安全边界。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `BROWSER_SESSION_UNKNOWN` | 子进程重启后旧会话失效 | `browser_reset_session` |
| 工具超时 | 页面卡死/未渲染完成 | 稍后重试;`browser_reset` 重置标签 |
| 导航被拒 | 非 HTTP(S) 协议 | 检查 URL;`httpOnly` 配置 |
| 快照为空 | 页面尚未加载 | 等待后重试 `browser_snapshot` |
