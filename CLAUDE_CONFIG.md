# MCP Client Configuration

The easiest way is the VS Code extension: sign in from the **Overleaf** panel, then run **Overleaf: Connect an AI Client…** and pick your client, or **Every AI tool found on this computer**. It writes the configuration below for you.

Without VS Code, download `overleaf-mcp.js` from the [latest release](https://github.com/GhoshSrinjoy/Overleaf-mcp/releases/latest) to `~/.overleaf-mcp/server/` (the extension installs the same file there) and use the entries below. Every client shares one sign-in, saved in `~/.overleaf-mcp/credentials.json`: sign in once with `node ~/.overleaf-mcp/server/overleaf-mcp.js login --browser`, or ask the assistant to use the `sign_in` tool.

## Command-line assistants

| Assistant | Command (macOS / Linux) |
| --- | --- |
| Claude Code | `claude mcp add --scope user overleaf -- node ~/.overleaf-mcp/server/overleaf-mcp.js` |
| Codex CLI | `codex mcp add overleaf -- node ~/.overleaf-mcp/server/overleaf-mcp.js` |
| GitHub Copilot CLI | `copilot mcp add overleaf -- node ~/.overleaf-mcp/server/overleaf-mcp.js` |

On Windows, run them in PowerShell with the full path and a quoted `'--'` (PowerShell removes a bare `--` before it reaches these tools), for example:

```powershell
codex mcp add overleaf '--' node "$HOME\.overleaf-mcp\server\overleaf-mcp.js"
```

To replace an older entry, remove it first: `claude mcp remove --scope user overleaf`, `codex mcp remove overleaf`, `copilot mcp remove overleaf`.

Codex stops tool calls after 60 seconds by default; for projects that take longer to compile, add `tool_timeout_sec = 300` under `[mcp_servers.overleaf]` in `~/.codex/config.toml`.

## JSON configuration files

Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Gemini CLI (`~/.gemini/settings.json`) and most other clients take the same entry:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\.overleaf-mcp\\server\\overleaf-mcp.js"]
    }
  }
}
```

GUI apps may not see your shell's `PATH`; use the absolute path to `node` if `node` alone is not found.

**Claude Desktop** can skip all of this: open `overleaf-mcp.mcpb` from the release page (Settings → Extensions → Install Extension…). It runs with Claude Desktop's built-in Node.js.

**npx instead of a downloaded file:** use `"command": "npx", "args": ["-y", "https://github.com/GhoshSrinjoy/Overleaf-mcp/releases/latest/download/overleaf-live-mcp.tgz"]`. On Windows, clients that cannot start `npx` themselves need `"command": "cmd", "args": ["/c", "npx", "-y", "…"]`.

## Docker (headless; Git tokens and/or a web session)

Set `cwd` to your clone so `docker compose` finds `docker-compose.yml`, `projects.json` and `./data`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "docker",
      "args": ["compose", "run", "--rm", "-T", "mcp"],
      "cwd": "D:\\src\\overleaf_mcp"
    }
  }
}
```

Run `docker compose build` once. No Redis container is needed any more. To use the web session inside Docker, sign in once with `docker compose run --rm mcp login --cookie "<overleaf_session2 value>"`.

## HTTP (while VS Code is running)

`http://127.0.0.1:39847/mcp` with header `Authorization: Bearer <token>`; **Overleaf: Show MCP Connection Details** copies the token. The HTTP endpoint shares VS Code's live connections, so edits show up in open editors and the PDF preview immediately.
