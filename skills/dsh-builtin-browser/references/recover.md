# Recovering

- Page stuck or a script half-applied: `dsh_browser_refresh`.
- Session wedged after a carrier loss: `dsh_browser_reset_session` (this task only), then re-open
  and re-read the page. A lost carrier means the page context is gone — nothing you knew about it
  still holds.
- A call fails with a reason you cannot place: `dsh_browser_doctor` (session, page state, probe
  buffers, which tools this task restricted away), then `dsh_browser_help` for the topic.
- Everything is refused with "restricted": the task restricted its own tools. `dsh_browser_restrict`
  with the needed names lifts it; observation tools are never blocked.
- Do not retry a state-changing call blindly after an error. Read first, decide second.
