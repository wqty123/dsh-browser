# Locating things

- Prefer roles and names (`dsh_browser_a11y`) over CSS when the page is a normal app: a label
  survives a re-render, a generated class does not.
- `dsh_browser_snapshot` numbers every interactive element and appends `{#id}` / `{[name=x]}`
  when it can derive one — copy that straight into `{by:"css", value:"#id"}`.
- Text targets match the element's own visible text or aria-label; if two match, pass `index`.
- `dsh_browser_find` searches the page text and returns viewport points — use it to find a table
  row or a sentence, then click at the point or scroll the element into view.
- An element inside an iframe or shadow root is reachable, but only when same-origin; a
  cross-origin frame is a wall — report it instead of guessing coordinates at random.
