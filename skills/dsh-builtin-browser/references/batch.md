# Batching with dsh_browser_do

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
