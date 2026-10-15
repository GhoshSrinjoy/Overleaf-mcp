# Changelog

## 2.1.0

### Added
- PDF preview in VS Code: compile on Overleaf and read the PDF beside the editor (pdf.js). Recompile and stop, automatic recompiles on any change (your saves, collaborators, AI edits) or only on save (`overleafMcp.pdf.autoCompile`), draft mode, stop on first error, errors and warnings with links to the line, zoom, page navigation, find, save and open externally, and the raw compile log. Restored after restarting VS Code.
- SyncTeX in both directions: double-click the PDF to open the source line; **Show in PDF** (editor context menu and title bar) highlights where a line ended up. Works for Overleaf files and synced local copies.
- Compile problems are also shown on synced local copies.
- AI client setup for Codex CLI, GitHub Copilot CLI and Gemini CLI, and **Every AI tool found on this computer** to configure all installed assistants at once.
- `sign_in` tool: an assistant can open the Overleaf login page itself; the session is shared with every assistant on the computer (`OVERLEAF_SERVER_URL` picks a self-hosted server).
- Release downloads: the server as one file (`overleaf-mcp.js`), an npm package (`overleaf-live-mcp`), a Claude Desktop bundle (`overleaf-mcp.mcpb`) and the extension (`overleaf-mcp.vsix`), built with `npm run package:release`.

### Changed
- **Compile** in the panel now opens the PDF preview.
- Compiles that Overleaf turns away for following too closely on another are retried after a short wait.
- Setup commands run in Command Prompt on Windows, so the `--` before the server command is not lost.

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
