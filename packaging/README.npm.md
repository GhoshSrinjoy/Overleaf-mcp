# overleaf-live-mcp

An MCP server for [Overleaf](https://www.overleaf.com). It gives any AI assistant that speaks the Model Context Protocol live access to your Overleaf projects: list and search them, read files and outlines, make exact edits (optionally as tracked changes), upload files, compile with errors reported as `file:line`, and browse history. It talks to Overleaf the way the Overleaf editor does, so edits merge with collaborators in real time. It works on every Overleaf plan and on self-hosted Overleaf.

Needs Node.js 20 or newer. The package is a single file with no dependencies.

## Sign in

```bash
npx -y overleaf-live-mcp login --browser
```

A browser window opens on the Overleaf login page; log in as usual and it closes by itself. The session is saved in `~/.overleaf-mcp/credentials.json` (readable only by you). You can also skip this step: the `sign_in` tool lets the assistant open the login page when it first needs it.

Self-hosted Overleaf: add `--server https://overleaf.example.com`.

## Connect your assistant

| Assistant | Command |
| --- | --- |
| Claude Code | `claude mcp add --scope user overleaf -- npx -y overleaf-live-mcp` |
| Codex CLI | `codex mcp add overleaf -- npx -y overleaf-live-mcp` |
| GitHub Copilot CLI | `copilot mcp add overleaf -- npx -y overleaf-live-mcp` |
| Gemini CLI | add `"overleaf": {"command": "npx", "args": ["-y", "overleaf-live-mcp"]}` under `mcpServers` in `~/.gemini/settings.json` |
| Cursor, Windsurf, Claude Desktop, others | add the same entry under `mcpServers` in the client's MCP config |

On Windows, clients that cannot start `npx` directly need `cmd /c npx -y overleaf-live-mcp` instead. Claude Desktop users can install the one-click bundle (`overleaf-mcp.mcpb`) from the [releases page](https://github.com/GhoshSrinjoy/Overleaf-mcp/releases/latest).

## Command line

```
overleaf-live-mcp                      serve MCP over stdio (what assistants start)
overleaf-live-mcp --http [--port N]    serve MCP over HTTP on 127.0.0.1 with a bearer token
overleaf-live-mcp login --browser | --cookie <value> | --email <e> --password <p>
overleaf-live-mcp logout | status
overleaf-live-mcp sync <project> [folder]   keep a local folder in two-way sync
```

The VS Code extension (PDF preview, project panel, live editing) and full documentation are at https://github.com/GhoshSrinjoy/Overleaf-mcp.
