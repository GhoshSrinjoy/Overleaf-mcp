# Claude MCP Client Configuration

Add the following entry to your MCP client configuration (for Claude Desktop, edit `claude_desktop_config.json`). Set `cwd` to your clone path so `docker compose` picks up the included `projects.json` and env defaults (including Git author identity for commits):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "docker",
      "args": ["compose", "run", "--rm", "-T", "mcp"],
      "cwd": "D:\\\\src\\\\overleaf_mcp"
    }
  }
}
```

If you prefer to run the server directly on Node.js instead of Docker, swap the command to `node` and point to `overleaf-mcp-server.js`. In that case ensure a Redis instance remains reachable on the host, as noted in `README.md:88` and `README.md:118`.
