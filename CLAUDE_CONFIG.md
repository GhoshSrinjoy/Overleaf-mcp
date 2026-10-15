# MCP Client Configuration

The easiest way is the VS Code extension: sign in from the **Overleaf** panel, then run **Overleaf: Connect an AI Client…** and pick your client. It writes the configuration below for you.

## Stdio (works with or without VS Code running)

The extension keeps a stable copy of the server at `~/.overleaf-mcp/server/overleaf-mcp.js` and shares its sign-in through `~/.overleaf-mcp/credentials.json`:

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

`http://127.0.0.1:39847/mcp` with header `Authorization: Bearer <token>`; **Overleaf: Show MCP Connection Details** copies the token.
