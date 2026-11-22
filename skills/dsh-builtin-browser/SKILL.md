---
name: dsh-builtin-browser
description: Use when a task needs a real web page — opening a URL, reading or extracting from it, filling and submitting a form, uploading an attachment, checking whether a result actually happened, or recovering after a page or carrier goes away. Covers how to drive the browser with dsh_browser_code, how to batch steps, and how to verify instead of guessing.
---

# Driving the browser

On a supported Desktop sidebar, the user can watch and take over the same browser tab.
Manual Web sidebar browsing supports references and human takeover, not native CDP.
If an operation reports a missing or stale carrier, explain the limitation and ask the user
to repair the bridge or select another supported carrier. Do not open another browser
as a fallback on your own.

The default surface exposes core `dsh_browser_*` tools. For a missing native tool, use
`dsh_browser_load_tools` with an array of group names, such as `{groups: ['debug']}`.
Groups: `forms`, `navigation`, `debug`, `session`, `more`.

Use `dsh_browser_do` for a fixed list of steps. In standard mode, use `dsh_browser_code`
for loops and branching; in PTC mode with the default surface, use DSH's `run_code`.
The code tool runs JavaScript cells in a persistent per-task REPL. Top-level bindings
survive between cells. Call any browser tool with
`await tools.dsh_browser_<name>(args)` and the same arguments as its native tool.
Independent reads may overlap under `Promise.all`; actions run in order. Print findings
as you go; output printed before a deadline or mid-run cancellation is returned.

```js
await goto_url('https://example.com/search')
await type('input[name=q]', 'wireless headphones', { submit: true })
await wait_for_element('.result')
const rows = await js(`[...document.querySelectorAll('.result')].slice(0, 10).map(r => ({
  title: r.querySelector('h3')?.innerText, price: r.querySelector('.price')?.innerText }))`)
rows.length
```

The next cell can keep using `rows`.

## Helpers

- Navigation: `goto_url(url)`, `new_tab(url)`, `wait_for_load()`, `page_info()`, `back()`, `forward()`,
  `refresh()`, `list_tabs()`, `switch_tab(tabId)`, `close_tab(tabId)`.
- Page data: `js(expr)` (objects, arrays and exact strings come back as data; `return` works),
  `read({selector, maxChars})`, `snapshot()`, `find(text)`, `state()`, `screenshot()`.
- Input: `click(target)`, `type(target, text, {submit})`, `fill_input(target, text)`, `select(target, optionText)`,
  `fill(fields, {submit})`, `click_at_xy(x, y)`, `type_text(text)`, `press_key(key)`, `scroll(dy)` or `scroll(x, y, dy)`,
  `upload_file(selector, path)`. A `target` is visible text, a CSS selector, `{text|css|xpath, index}` or `{x, y}`.
- Waiting: `wait_for_element(selector)`, `wait_for_network_idle()`, `sleep(ms)` only as a last resort.
- References: `refs.capture({excerptText})`, `refs.list()`, `refs.reveal({referenceId})`.
- Everything else: `call(name, args)` (download, console, network, wait_for_response, dialog, hover,
  drag, set_value, check, scrape, a11y, assert, do, reset_session, ...). `await help()` lists the
  actions and `await help(name)` describes one.

## Batch, do not drip

Every call is a full model turn. Put a run of steps in one cell, and use loops for lists and
pagination. A failing helper throws, so wrap the risky step in try/catch and try another selector
in the same cell. Return only what you need: a few fields from `js()` beat a whole `read()`.

## Verify, then retry

"Clicked" and "the form accepted it" are different claims: check the URL, a confirmation message,
or a server response before moving on. Arm `wait_for_response` before the triggering action
inside a code cell; see [batch examples](references/batch.md). If a cell timed out or was
cancelled, inspect the current page before repeating anything that changes server state.
If access is denied, report what you verified. For a research task, you can use a different,
publicly available source without bypassing the original site's access restrictions.

## Never

- For a CAPTCHA, slider, login, 2FA or payment, call `dsh_browser_request_takeover` with a short
  reason. Inspect the page after `done`; never report `skipped` or `cancelled` as success.
- Do not paste cookies, tokens or exported login state into the conversation.
- Do not assume another task's tabs or navigation are visible to you: each task has its own
  session and its own REPL.
