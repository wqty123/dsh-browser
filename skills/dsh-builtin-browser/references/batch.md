# Batching browser actions

## Fixed steps with dsh_browser_do

One call, one result, and it stops at the first step that cannot proceed:

```json
{"steps": [
  {"open": "https://example.com/search"},
  {"field": {"target": {"by": "css", "value": "#q"}, "text": "invoice"}},
  {"key": "Enter"},
  {"wait_idle": {}},
  {"check": {"text": "3 results"}}
]}
```

Rules that keep a batch honest:

- Give each step exactly one key; anything else is refused before the first action runs.
- Put a `check` after the steps that change server state — the batch then fails at the step where
  the outcome was already wrong, not three steps later.
- `wait_idle` waits for in-flight requests to drain and the page to go quiet for 300 ms; use it
  instead of `sleep_ms` unless the page genuinely needs wall-clock time.
- A failed batch reports `stoppedAt`, `completed` and a per-step log, so re-running only the
  remainder is a deliberate choice, and it starts with a fresh `state`.

## JavaScript cells

Use `dsh_browser_code` in standard mode for branching, loops, or overlapping reads.
In DSH PTC mode with the default tool surface, use `run_code` and the same native
browser tool definitions. On the plugin REPL, print incremental results and keep
variables for the next cell:

```js
await tools.dsh_browser_open({ url: 'https://example.com' })
const [content, matches] = await Promise.all([
  tools.dsh_browser_content({ format: 'markdown', maxChars: 400 }),
  tools.dsh_browser_find({ text: 'Example Domain' }),
])
print({ content, matches })
```

To verify a response in the same REPL cell, issue the wait first, then the action:

```js
const response = tools.dsh_browser_wait_for_response({ urlContains: '/search', timeoutMs: 5000 })
await tools.dsh_browser_click({ target: { by: 'css', value: 'button[type=submit]' } })
print(await response)
```

The REPL helper does the same in one call: `wait_for_response(urlContains, trigger, opts)`
starts watching before it calls `trigger()` and returns the matching response row:

```js
const saved = await wait_for_response('/api/profile', () => click('Save'), { status: 200 })
await wait_for_text('Profile saved')
```

When the condition is page state rather than text or a response, poll an expression instead of
sleeping; the timeout error quotes the last value it saw:

```js
const count = await wait_until(`document.querySelectorAll('.result').length >= 20 && document.querySelectorAll('.result').length`, { timeoutMs: 8000 })
```

Adapt the URL and selector to the current page. The scheduler arms the response
wait before it lets the action run. Issue unrelated reads in parallel, not competing
mutations. A timeout or cancellation does not undo actions that already ran.
