# Changelog

## 2.0.0

A rewrite as a VS Code extension plus a standalone MCP server sharing one TypeScript core.

### Added
- VS Code extension: sign in (browser, session cookie, or password on self-hosted servers), a panel with every project and its live file tree, `overleaf://` files that save live and reload when others edit, compile into the Problems panel, search, and one-click setup for AI clients. Registers the server with VS Code's MCP support.
- Two-way local folder sync with three-way merging, conflict markers, `.overleafignore`, and a lease so only one process syncs a folder (`overleaf-mcp sync` without VS Code).
- Live access over Overleaf's realtime protocol: millisecond reads and OT edits that merge with collaborators, for both `sharejs-text-ot` and `history-ot` documents.
- Suggest mode: edits recorded as tracked changes to accept or reject in Overleaf.
- Tools: `grep` (ripgrep, with a JavaScript fallback), ranked `search` (BM25), `get_outline` across `\input`/`\include`, `get_section`, `edit_file` (exact replacements), `write_file`, `delete_file`, `move_file`, `create_folder`, `upload_file`, `download_file`, `compile` with `file:line` errors, `history`, `history_diff`, `create_project`, `pin_projects`, `status`.
- Streamable HTTP endpoint on `127.0.0.1` with bearer-token authentication.
- CLI: `login` (browser, cookie, password), `logout`, `status`, `sync`, `--http`.
- Tests: unit tests, integration tests against a local Overleaf Community Edition, and extension tests inside VS Code.

### Changed
- Git-token projects (`projects.json`) are served by the new core: safe argument passing, tokens kept out of `.git/config`, push retries when someone pushed first, history mapped to version numbers.
- Docker image builds a single-file server with `git` and `ripgrep`; `docker compose run --rm -T mcp` keeps working.

### Removed
- Redis and BullMQ, and the old `overleaf-mcp-server.js` / `overleaf-git-client.js`.
