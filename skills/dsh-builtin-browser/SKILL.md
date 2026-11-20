---
name: dsh-builtin-browser
description: Use when a task needs a real web page — opening a URL, reading or extracting from it, filling and submitting a form, uploading an attachment, checking whether a result actually happened, or recovering after a page or carrier goes away. Covers how to drive the browser with dsh_browser_code, how to batch steps, and how to verify instead of guessing.
---

# Driving the browser

The browser is a real Chromium the human can watch and take over. You drive it with one tool,
`dsh_browser_code`, after Browser Use 1.0's `python` tool: each call is a JavaScript cell in a
persistent REPL. Top-level `const`/`let`/`function` survive calls, the last expression is printed,
and every browser helper is async (`await` it).

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
  `fill(fields, {submit})`, `click_at_xy(x, y)`, `type_text(text)`, `press_key(key)`, `scroll(dy)`,
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

"Clicked" and "the form accepted it" are different claims: check the URL, a confirmation text or
`call('wait_for_response', ...)` before moving on. A cell that timed out may have partly run:
inspect before repeating anything that changes server state.

## Never

- Never solve a CAPTCHA, slider, login, 2FA or payment yourself: call `dsh_browser_request_takeover`.
- Do not paste cookies, tokens or exported login state into the conversation.
- Do not assume another task's tabs or navigation are visible to you: each task has its own
  session and its own REPL.
