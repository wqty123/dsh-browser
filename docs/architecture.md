# 架构说明

## 三层结构

```
agent (browser_* 工具)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (由宿主外壳提供)
  → WebContentsView + webContents.debugger (CDP)
```

### seam 层(`src/browser/`)

`BrowserRuntime` 以 Cordis Service 形式注册为 `ctx.browser`:

- **provider 注册**:`registerBrowserProvider(provider)` 登记一个实现 `BrowserProvider` 接口的 provider,重名抛 `BROWSER_DUPLICATE_PROVIDER`;disposer 挂在注册方自身的 fiber 上,插件重载时正确清理。
- **provider 选择**(执行期解析,不依赖顺序):
  - 配置了 id 且注册且可用 → 该 provider
  - 配置了 id 但未注册 → `BROWSER_PROVIDER_CONFIGURED_MISSING`
  - 配置了 id 但不可用 → `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`
  - 未配置、恰一个可用 → 自动选择
  - 未配置、多个可用 → `BROWSER_PROVIDER_AMBIGUOUS`
  - 未配置、无可用 → `BROWSER_PROVIDER_UNAVAILABLE`
- 所有请求/结果类型(`BrowserProvider` 接口、`BrowserError` 错误码)定义在 `src/browser/types.ts`。

### provider 层(`src/browser-electron/`)

`ElectronBrowserProvider` 通过 `ElectronBrowserViewHost` 接缝操作视图,与 Electron 解耦:

- 会话 = 有序标签列表 + 历史;每次 `open()` 新建会话(工具层按任务缓存复用);
- 每个标签对应一个视图(handle);`showActive` 让宿主把活动标签的视图置顶;
- 页面驱动全部走 CDP:`Page.navigate` / `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Input.insertText` / `Page.captureScreenshot`(兜底);
- **截图优先走宿主原生 `capturePage`**(新增 `capture` 通道):CDP `captureScreenshot` 在窗口存在多个(隐藏)视图时会挂起,原生捕获对可见视图快速可靠,失败时自动回退 CDP(临时摘除其他视图保证单视图状态);
- 所有 CDP 调用都有超时兜底(`withTimeout`),避免卡死工具调用;
- 历史记录单调递增的 seq,截断(500 条)后不回绕;失败导航只记一条。

### 工具层(`src/tool-browser/`)

20 个 `browser_*` 工具,按**调用方任务**(`exec.agent.id`)维护独立浏览器会话:

- 会话缓存 `sessionsByTask`:同一任务复用同一会话,并发首开去重;
- `browser_reset_session` 关闭本任务会话并遗忘映射(即使 close 抛错也清除,下次调用重建);
- 会话生命周期绑定 agent 作用域 ctx:agent(DSH 会话)销毁时自动关闭对应浏览器会话,任务结束后不再泄漏窗口/视图;
- 会话/开启动态/白名单都是**每插件实例(每 context)作用域**的,多 context 互不共享、互不污染;
- `browser_restrict` 维护本实例白名单,守卫所有非只读工具;
- 输出 schema 与返回值严格一致(DSH 运行时会校验,`additionalProperties: false` 下多一个字段都会报错)。

## 自托管实现(纯 `dsh web`)

没有桌面外壳时,`RemoteElectronViewHost` 接管:

```
父进程(DSH)                        子进程(Electron main)
RemoteElectronViewHost  ──TCP JSON-RPC──▶  host-main.js
  resolveElectronPath()                    BrowserWindow('dsh-browser')
  ElectronChildClient                      WebContentsView × N
  DeferredRemoteView(物化缓存)              webContents.debugger(CDP)
```

- **协议**:本机 loopback TCP,每行一个 JSON(`{ id, op, ... }` ↔ `{ id, ok, result|err }`);
- **认证**:每次 spawn 生成随机 token(经 `--rpc-token` 传入),子进程首条消息必须回传该 token(`hello`);服务端只接受**一个**连接,其余连接直接断开——本机其他进程无法伪冒子进程或注入回复;
- **Electron 定位**:① peer 依赖 → ② `ELECTRON_PATH` → ③ 锚点与 pnpm store 中**版本最新**者(33.x 有合成器缺陷,建议 ≥ 40);
- **稳健性**:子进程/套接字都有 `error` 监听(否则未捕获事件会炸掉整个 DSH 进程);子进程退出自动重启;物化失败可重试;下载仅限 HTTP(S)、`savePath` 必须绝对路径(可配置 `downloadDir` 限定目录)、流式限流 + Content-Length 提前拒绝、256MB 上限与 60s 超时;cookie 导出/恢复有 30s 超时;
- **视图可见性**:多标签/多会话时,`showView` 隐藏其他视图并把目标视图置顶(remove+re-add),确保用户看到的是活动标签;
- **孤儿防护**:父进程断开时子进程自动退出,不留僵尸窗口;
- **cookie 落盘**:子进程使用独立 userData 目录(`<DSH_HOME>/dsh-builtin-browser-host`),登录态跨重启保留(另有 `browser_auth` 手动导出/恢复)。

## 关键设计决策

| 决策 | 原因 |
| --- | --- |
| 任务级会话隔离,共享 cookie | 并行任务不抢页面;登录一次到处可用 |
| 原生 capturePage 优先,CDP 兜底 | CDP 截图多视图挂起;原生捕获窗口未激活时失败——两通道互补 |
| 自动选最新 Electron | 33.x 合成器缺陷导致截图间歇失败 |
| 独立 userData | 多实例争用默认目录导致 GPU 缓存/会话锁冲突 |
| withTimeout 全覆盖 | 卡死的 CDP 调用必须能被工具超时兜底 |
| 输出 schema 严格匹配 | DSH 运行时会校验返回值,多字段即报错 |
