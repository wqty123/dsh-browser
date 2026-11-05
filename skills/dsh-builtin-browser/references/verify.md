# Verifying

| Question | Tool |
| --- | --- |
| Is the element there / the text there / the URL changed? | `dsh_browser_assert` |
| Did a request reach the server? | `dsh_browser_wait_for_response` |
| What did the page log or fetch? | `dsh_browser_console`, `dsh_browser_network` |
| Did a field take the value? | `dsh_browser_get_value` |

A submit is the dangerous case. After clicking submit: wait for the response, assert the visible
outcome, and if the call died before either answer arrived, **read the site's own record** (the
list page, the order history) before acting again. "Result unknown" is an acceptable answer to
report; a second submit is not.
