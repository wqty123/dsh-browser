---
name: dsh-builtin-browser
description: Use when a task needs a real web page — opening a URL, reading or extracting from it, filling and submitting a form, uploading an attachment, checking whether a result actually happened, or recovering after a page or carrier goes away. Covers how to drive the browser with dsh_browser_code, how to batch steps, and how to verify instead of guessing.
---

# Driving the browser

The browser is a real Chromium the human can watch and take over. You drive it with one tool,
`dsh_browser_code`: write an async JavaScript function body that calls the browser helpers, and
return what you need to see. One call can open a page, act, wait, extract and decide.

```js
await open('https://example.com/search')
await type('input[name=q]', 'wireless headphones', { submit: true })
await waitFor({ text: 'results' })
return await js(`[...document.querySelectorAll('.result')].slice(0, 10).map(r => ({
  title: r.querySelector('h3')?.innerText, price: r.querySelector('.price')?.innerText }))`)
```

## Helpers

- `open(url)`, `back()`, `forward()`, `refresh()` — navigate; returns a page summary.
- `click(target)`, `type(target, text, {submit})` / `type(text)`, `press(key)`, `select(target, optionText)`,
  `fill(fields)`, `scroll(deltaY | {toBottom, toTop, selector})`.
- `target` is visible text (`'Sign in'`), a CSS selector (`'#email'`, `'button[type=submit]'`),
  `{text|css|xpath, index}` or `{x, y}` from a screenshot. A target re-resolves on every call.
- `read({format, selector, maxChars})` — page text as markdown; `snapshot()` — numbered interactive
  elements with labels and selectors; `find(text)`; `state()`; `tabs()`.
- `js(expr)` — evaluate in the page and get the value back (objects and arrays come back as data).
  Best for lists, tables and attributes: extract exactly the fields you need.
- `waitFor({text | gone | url | selector, timeoutMs})` waits on a fact; `sleep(ms)` only as a last resort.
- `screenshot({fullPage})` — for canvas-only pages or to show the human; vision models see the image.
- `refs.capture({excerptText})`, `refs.list()`, `refs.reveal({referenceId})` — browser references.
- `call(name, args)` reaches every other action with its structured result: `download`, `upload`,
  `console`, `network`, `wait_for_response`, `dialog`, `hover`, `drag`, `switch_tab`, `close_tab`,
  `set_value`, `check`, `get_value`, `scrape`, `a11y`, `assert`, `do`, `doctor`, ... `help()` lists
  them and `help(name)` describes one.
- `log(...)` prints; the return value is printed. A failing helper throws — wrap it in try/catch to
  try another selector or route in the same call.

## Batch, do not drip

Put a whole run of steps in one call, and use loops for pagination and lists. Return only what you
need: a few fields from `js()` beat a whole `read()` of the page. When you do not know the page yet,
`open()` then `snapshot()` in the first call, then act on what it showed.

## Verify, then retry

"Clicked" and "the form accepted it" are different claims: check the URL, a confirmation text or
`call('wait_for_response', ...)` before moving on. Before retrying anything that changes server
state, check that the previous attempt did not already take effect.

## Never

- Never solve a CAPTCHA, slider, login, 2FA or payment yourself: call `dsh_browser_request_takeover`.
- Do not re-submit a form whose result you have not verified — a lost reply is not a failed submit.
- Do not paste cookies, tokens or exported login state into the conversation.
- Do not assume another task's tabs or navigation are visible to you: each task has its own
  session, and `call('reset_session')` ends yours without touching anyone else's.
