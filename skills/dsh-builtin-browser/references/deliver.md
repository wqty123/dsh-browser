# Delivering a file somewhere else

The browser's job ends with a file on disk. Sending it to Feishu (Lark) drive, Baidu Netdisk or any
other storage is a separate capability the user connects as an MCP server — both platforms ship an
official one (`lark_drive_upload`, `baidu-netdisk/mcp`'s upload tool). The plugin does not hold
their credentials and should not.

## The path

1. `dsh_browser_download` saves the URL through the directory admission gate and returns an
   **absolute path**. It never overwrites an existing file; if the name is taken, ask for another.
2. Hand that exact path to the upload tool the user connected, e.g.
   `lark_drive_upload({ file_path: "<returned path>", folder_token: "<the user's folder>" })`.
3. Report both facts: where the file now sits locally, and what the upload tool answered.

## Rules

- **Never** report "saved to Feishu" from the download alone. The download proves a local file; only
  the upload tool's reply proves the remote copy.
- If the upload tool fails or is not connected, say so plainly and leave the local path — the file
  is still usable and the human can move it by hand. Do not silently retry somewhere else.
- A folder id / token belongs to the user's workspace: ask for it, or read it from the tool's own
  documentation, instead of guessing a default.
- Before uploading something sensitive (an invoice, a screenshot with an account name), say what is
  about to leave the machine.

## When the user wants this to happen automatically

A per-call handoff (`dsh_browser_download` with a `handoff` argument) and a settings field for the
default tool are planned; until they exist, the two-step form above is the supported path and it
keeps the human in control of where their files go.
