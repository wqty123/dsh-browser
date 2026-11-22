---
name: dsh-debug-host
description: Use when the thing under test IS DSH itself - a client bundle, the settings panel, the sidebar UI - and the page has to be refreshed and inspected. Covers which surface to open DSH on, why the sidebar cannot host it, and how to read the result.
---

# Debugging DSH itself

Testing DSH is different from testing a page. The subject is the shell that is running your tools, so it
must be opened on a surface you control directly.

## Which surface

- **Built-in browser for DSH.** Open the DSH URL (the one carrying the token) in the plugin's own browser
  and work in that page: refresh it, inspect it, read its DOM. That window is yours to drive.
- **Sidebar for everything else.** Ordinary pages belong in the DSH sidebar, where the reader can watch
  and take over. Do not open DSH there.

## Why the sidebar cannot host DSH

The sidebar serves pages through the same-origin guest proxy. Pointing it at DSH makes the host fetch the
very server that is serving the request; what comes back is a network-looking failure
(`guest proxy: cannot reach 127.0.0.1:PORT: fetch failed`) that says nothing about the real mistake.
The proxy now refuses loopback and private targets outright, so the answer is a plain refusal instead of a
timeout - treat it as a routing reminder, not a bug in the page.

## Refresh, do not restart

Client-side plugin code is fetched once per page load. A rebuilt `client.js`, a new settings row, a changed
handler - none of that reaches a page that is already open. Refresh the DSH page. Restarting the host is a
different, heavier action and does not fix a stale page.

Tool handlers are registered when the host starts. A rebuilt tool body may therefore need a host restart,
while a rebuilt client body needs only a page refresh. Know which of the two you changed.

## Reading the result

1. `dsh_browser_state` first: URL, title, load state, counts. A blank title with no elements is a signal,
   not an empty page - compare it against what that surface is expected to return.
2. Then `dsh_browser_execute` for the specific fact (`document.title`, a computed style, a dataset value).
3. Keep the DSH tab open between steps; reopening it each time loses the very state you were testing.

## Rule of thumb

If the question is "does DSH behave correctly", the answer comes from a DSH page in the built-in browser,
refreshed after every client change. If the question is "does this site work", the answer comes from the
sidebar.

## panel 模式能做什么、不能做什么

`surface: "panel"` 在创建浏览器会话之前就返回，所以：

- 能做：把页面放进 DSH 侧栏、让读者看到（`open`）。
- 不能做：`snapshot` / `execute` / `scrape` / `click` / `fill` 这些依赖会话的工具，会以“无会话”失败。

要读页面内容或操作页面，用 `surface: "builtin"`（仅本机地址允许），或改用侧栏的引用通道（划选 → 浮条 → 引用）。
不要把“panel 下读不到页面”当成 bug 反复排查：那是这一档的既定边界。
