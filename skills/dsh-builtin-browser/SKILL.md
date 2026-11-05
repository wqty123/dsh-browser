---
name: dsh-builtin-browser
description: Use when a task needs a real web page — opening a URL, reading or extracting from it, filling and submitting a form, uploading an attachment, checking whether a result actually happened, or recovering after a page or carrier goes away. Covers which dsh_browser_* tool to reach for, how to batch steps, and how to verify instead of guessing.
---

# Driving the browser

The browser is a real Chromium the human can watch and take over. Your tools drive it over the
page itself, so everything here works the same on the desktop sidebar, on an installed Chrome and
on the plugin's own window.

## Before acting

1. `dsh_browser_state` — where am I? URL, load state, requests in flight, what is on the page.
2. `dsh_browser_snapshot` (numbered interactive elements) or `dsh_browser_a11y` (roles, names,
   states) — pick the structure map, not a screenshot, unless the page is canvas-only.
3. Then act with a semantic target: `{by: "text"|"css"|"xpath", value}`. Elements carry a stable
   CSS selector, so a click re-resolves the element; never trust an index from an older snapshot.

## Batch, do not drip

`dsh_browser_do` runs a list of steps in ONE call and stops at the first that cannot proceed.
"Click search → type the query → press Enter → wait for results" is one call, not five. Steps:
`open`, `tap`, `field`, `type`, `key`, `scroll`, `sleep_ms`, `wait_text`, `wait_gone`, `wait_url`,
`wait_idle`, `eval`, `check`. Waits are condition-based; a `tap` whose target is covered by a
cookie banner dismisses the banner first.

## Wait on facts, not on time

- `dsh_browser_wait` — load complete, an expected URL or a selector.
- `dsh_browser_wait_for_response` — a server answer arrived **after** this call started. This is
  the "did the submit reach the server" wait; a screenshot cannot answer it.
- `dsh_browser_console` / `dsh_browser_network` — what the page actually did when the screen does
  not explain the failure.

## Verify, then retry

`dsh_browser_assert` checks a selector, text, URL or JS predicate and returns evidence per check.
"Clicked" and "the form accepted it" are different claims. Before retrying anything that changes
server state, assert that the previous attempt did not already take effect.

## Files

- `dsh_browser_download` — save a URL through the directory admission gate (never overwrites).
- `dsh_browser_upload` — put a local file (inside the workspace) into a file input.
- `dsh_browser_screenshot` — for the human, or when the page has no usable DOM.

## When the page fights you

- Dialogs: native page handling by default. Explicit accept/dismiss enables automatic answers; native restores page handling. `dsh_browser_dialog` reports them and can
  switch the policy to accept.
- Menus that appear on hover: use `dsh_browser_hover` before snapshotting. It moves the browser
  pointer and activates CSS hover styles and mouse handlers.
- Sliders, sortable lists, drop targets, and canvas strokes: use `dsh_browser_drag` with viewport
  CSS coordinates, then verify the resulting value, order, dropped data, or canvas state.
- Runs of canvas clicks: use `dsh_browser_click_sequence`.
- Something is odd and nothing explains it: `dsh_browser_doctor`, then `dsh_browser_help`.

## Never

- Do not re-submit a form whose result you have not verified — a lost reply is not a failed submit.
- Do not paste cookies, tokens or exported login state into the conversation.
- Do not assume another task's tabs or navigation are visible to you: each task has its own
  session, and `dsh_browser_reset_session` ends yours without touching anyone else's.
