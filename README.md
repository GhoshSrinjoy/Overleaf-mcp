![Overleaf MCP Server](assets/overleaf-mcp.png)
*Visualizing the bridge between Overleaf and AI through MCP*

*"I tried to argue with Overleaf, but it said my syntax was invalid."*

# Overleaf MCP

A VS Code extension and MCP server for Overleaf. Sign in once, see **all** your Overleaf projects in a VS Code side panel, open and edit them live, sync any project to a local folder, and give AI assistants (anything that speaks the Model Context Protocol) the tools to search, read, edit, and compile your papers — one project or many at a time. 🧠

🔗 **Repo:** https://github.com/GhoshSrinjoy/Overleaf-mcp

---

## Executive Summary

Version 2 is a rewrite around a single, faster core:

- **Live, not polled.** The server talks to Overleaf the way the Overleaf editor does: one persistent realtime connection per project. Reading a file takes milliseconds instead of a `git pull` per call, and edits are applied as small operational-transform updates that merge with whatever collaborators are typing. They show up live in their browser.
- **Works on every plan.** Signing in with the Overleaf website session needs no paid Git integration and no per-project tokens. Git tokens still work for headless servers (your old `projects.json` keeps working).
- **No infrastructure.** Redis and BullMQ are gone. Per-project queues and file locks handle concurrency; the Docker image is a single file plus `git` and `ripgrep`.
- **Built for agents.** Exact search-and-replace edits, a "suggest mode" that records AI edits as tracked changes for you to accept or reject, ripgrep plus ranked (BM25) search across projects, a LaTeX outline that follows `\input`, and compile with errors reported as `file:line`.

**In short:** Overleaf ⇄ live connection ⇄ VS Code panel + local folders + MCP ⇄ your AI assistant.

---

## Business Problem

Overleaf is great for collaboration but closed to tooling: copy-pasting LaTeX into an assistant loses structure, and the Git bridge needs a paid plan, a token per project, and still can't tell you which projects you have. This project makes your whole Overleaf account browsable, editable and AI-accessible from your editor — without breaking collaborators' live sessions.

---

## Features

### VS Code extension

- 📚 **Projects panel** listing every project (pinned first, then by last update), expandable into its live file tree. Collaborators' file changes appear immediately.
- ✏️ **Live editing** of Overleaf files (`overleaf://` documents): saving pushes your change; edits from collaborators or AI tools reload open files; if a document changed while you edited, your save is merged on top instead of overwriting it.
- 🔁 **Local folder sync** (two-way): keep a project mirrored in a folder so local LaTeX builds, git and AI file tools work on real files. Edits on both sides merge; true clashes get conflict markers.
- 🧪 **Compile** on Overleaf with errors and warnings in the Problems panel; open the PDF.
- 🔎 **Search** across projects (the same engine the AI uses).
- 🔐 **Sign in with the browser** (Google, ORCID, institutional SSO, password, captcha — whatever Overleaf asks), by pasting a session cookie, or with email/password on self-hosted servers.
- 🔌 **One-click AI client setup** and automatic registration with VS Code's built-in MCP support.

### MCP server

20 tools, listed [below](#mcp-tools).

---

## Quick Start (VS Code)

1. Build and install the extension (until it is published):
   ```bash
   npm install
   npm run package                      # creates overleaf-mcp-2.0.0.vsix
   code --install-extension overleaf-mcp-2.0.0.vsix
   ```
2. Click the **Overleaf** icon in the activity bar → **Sign in**. A browser window opens on the Overleaf login page; log in as usual and it closes by itself.
3. Your projects appear in the panel. Click a file to open it; right-click a project to **Pin for AI**, **Sync to Local Folder…**, **Compile** or **Open on Overleaf**.
4. Connect an assistant: panel menu (`…`) → **Connect an AI Client…**. VS Code's own chat (agent mode) sees the tools automatically.

Self-hosted Overleaf (Community Edition / Server Pro)? Run **Overleaf: Use a Different Overleaf Server…** first.

---

## Connecting AI clients

The extension installs a stable copy of the server at `~/.overleaf-mcp/server/overleaf-mcp.js` (it survives extension updates) and shares your sign-in with it through `~/.overleaf-mcp/credentials.json`. **Connect an AI Client…** writes the configuration for you; the equivalents by hand:

| Client | How |
| --- | --- |
| VS Code chat (agent mode) | Registered automatically ("Overleaf" in the tools list). |
| Claude Code | `claude mcp add --scope user overleaf -- node ~/.overleaf-mcp/server/overleaf-mcp.js` |
| Claude Desktop / Cursor / Windsurf | Add to the client's `mcpServers`: `{"overleaf": {"command": "node", "args": ["<home>/.overleaf-mcp/server/overleaf-mcp.js"]}}` |
| Any HTTP client | `http://127.0.0.1:39847/mcp` with `Authorization: Bearer <token>` (**Show MCP Connection Details** copies the token). Runs while VS Code is open. |

Stdio servers work with or without VS Code running. The HTTP endpoint shares the extension's live connections, so its edits show up in open editors instantly.

---

## MCP Tools

| Tool | What it does |
| --- | --- |
| `status` | Signed-in account, pinned projects, search engine |
| `list_projects` | All projects with ids, last update, owner, access, tags, local sync folder |
| `pin_projects` | Pin/unpin projects; pinned projects are the default scope, and one pinned project lets tools omit `project` |
| `create_project` | New blank or example project |
| `list_files` | File tree with the main document marked |
| `read_file` | Live content (optionally a line range); images come back as images |
| `grep` | Exact text or regex across one, several or all projects (ripgrep), with context lines and globs |
| `search` | Relevance-ranked passages for a topic (BM25 with fuzzy and prefix matching) |
| `get_outline` | Chapters/sections across `\input`/`\include`, each with `file:line` |
| `get_section` | The LaTeX of one section, found by title |
| `edit_file` | Exact search-and-replace edits, applied atomically and live; `suggest: true` makes them tracked changes; `dryRun` previews the diff |
| `write_file` | Create or overwrite a file (minimal live diff for existing docs) |
| `delete_file`, `move_file`, `create_folder` | File management |
| `upload_file`, `download_file` | Move files between this computer and a project |
| `compile` | Compile on Overleaf; errors/warnings with `file:line`; optionally save the PDF |
| `history`, `history_diff` | Project history (who changed what, when) and diffs between versions |

Every tool accepts a project by name, id or Overleaf URL. Errors explain how to recover (for example, an ambiguous `oldText` reports how many times it occurs; a near miss shows the passage that differs only in whitespace).

> Overleaf documents cannot contain emoji or other characters outside the Basic Multilingual Plane; tools reject such edits with the offending line instead of letting Overleaf corrupt them.

---

## Local folder sync

Right-click a project → **Sync to Local Folder…** (default `~/Overleaf/<project>`). The folder must be new or empty.

- Saving a file locally pushes it within a second; edits on Overleaf are written to the file.
- Changes made while sync was off are reconciled three ways (local / Overleaf / last synced): one-sided changes are copied, edits on both sides are merged, and clashing edits get `<<<<<<<` markers. Resolve and save; the resolution is pushed.
- Build output (`*.aux`, `*.log`, the main PDF, …) stays local; edit `.overleafignore` in the folder to change that.
- Only one VS Code window (or CLI) syncs a folder at a time; another takes over if it closes.
- Without VS Code: `overleaf-mcp sync "<project>" [folder]`.

---

## Headless, CLI and Docker

The server is a single self-contained file (`dist/mcp-server.js`, Node ≥ 20):

```text
overleaf-mcp                         serve MCP over stdio (what AI clients launch)
overleaf-mcp --http [--port N]       serve MCP over HTTP on 127.0.0.1
overleaf-mcp login --browser         sign in on the real login page
overleaf-mcp login --cookie <value>  or paste the overleaf_session2 cookie
overleaf-mcp login --email E --password P   (self-hosted servers)
overleaf-mcp status | logout
overleaf-mcp sync <project> [folder] two-way sync until Ctrl+C
```

**Docker** (your existing client config `docker compose run --rm -T mcp` keeps working):

```bash
docker compose build
docker compose run --rm mcp login --cookie "<overleaf_session2 value>"   # optional: web session
docker compose run --rm -T mcp                                         # what MCP clients run
```

The compose file mounts `projects.json` (Git tokens) and `./data` (session, caches, Git clones). Without a session, projects listed in `projects.json` are served through the Git bridge:

```json
{
  "projects": {
    "default": { "name": "My Paper", "projectId": "YOUR_PROJECT_ID", "gitToken": "YOUR_GIT_TOKEN" }
  }
}
```

Git-token projects support reading, searching, outlines, edits (commit + push, retried if someone pushed first) and history. Compile, suggest mode and project listing need the web session.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `OVERLEAF_MCP_HOME` | Data directory (default `~/.overleaf-mcp`) |
| `OVERLEAF_COOKIES` / `OVERLEAF_SESSION` | Session for headless use (full Cookie header, or the `overleaf_session2` value) |
| `OVERLEAF_SERVER_URL` | Server (default `https://www.overleaf.com`) |
| `PROJECTS_FILE` | Git-token projects file (default `<home>/projects.json`) |
| `OVERLEAF_GIT_TOKEN`, `OVERLEAF_PROJECT_ID` | Single Git-token project without a file |
| `OVERLEAF_GIT_AUTHOR_NAME`, `OVERLEAF_GIT_AUTHOR_EMAIL` | Commit identity for Git-token edits |
| `OVERLEAF_MCP_TOKEN`, `OVERLEAF_MCP_PORT` | Bearer token and port for `--http` |
| `OVERLEAF_MCP_RG` | Path to a ripgrep binary |

---

## Methodology

```text
                    ┌──────────────── Overleaf (overleaf.com or self-hosted) ────────────────┐
                    │  web API (projects, zip, uploads, compile, history)   realtime (socket.io) │
                    └───────────────▲────────────────────────────────────────▲────────────────┘
                                    │ session cookie                          │ OT updates, live events
┌──────────────────────── core (TypeScript) ──────────────────────────────────┴──────────────┐
│ SessionBackend ── realtime pool (1 connection/project, auto-reconnect)    GitBackend (tokens) │
│ OverleafService: project resolution · pins · snapshot cache · ripgrep / BM25 search          │
│                  LaTeX outline · log parser · 3-way merge · local mirror engine              │
└───────────────▲───────────────────────────────▲───────────────────────────────▲─────────────┘
                │                               │                               │
     MCP server (stdio / HTTP)          VS Code extension                CLI (sync, login)
     AI assistants                      panel · overleaf:// files ·      Docker image
                                        local sync · compile
```

1. **Sign-in.** A throwaway browser profile opens the real Overleaf login page; once you are in, the session cookie is captured over the DevTools protocol and the profile is deleted. Cookies live in VS Code's secret storage, mirrored (optionally) to an owner-only file for MCP servers started by other apps.
2. **Reading.** Documents are read over the realtime connection (always the latest text, including unsaved typing of collaborators). Search uses a local text snapshot per project, refreshed only when Overleaf reports the project changed.
3. **Writing.** Edits become OT updates against the version that was read; the server transforms them over concurrent edits. Overleaf's newer `history-ot` documents are supported, including tracked changes.
4. **Concurrency.** Per-project queues in-process, file locks across processes, and a lease for local sync folders.

---

## Security notes

- `~/.overleaf-mcp/credentials.json` holds the Overleaf session (owner-only permissions). Turn off `overleafMcp.mcp.shareSessionWithExternalClients` to keep it only in VS Code's secret storage.
- Signing out also ends the session on Overleaf when it was created by the browser or password sign-in; a pasted cookie is left alone (it is your browser's session).
- The HTTP endpoint listens on `127.0.0.1` only, requires a bearer token, and rejects browser (cross-origin) requests.
- Git tokens are passed to git through its environment, never written to `.git/config` or shown in process lists.
- `projects.json`, `data/` and `*.vsix` are git-ignored. Never commit tokens.

---

## Development

```bash
npm install
npm run build          # dist/extension.js and dist/mcp-server.js
npm run typecheck
npm test               # unit tests
```

Integration tests run against a local Overleaf Community Edition in Docker (nothing touches overleaf.com):

```bash
docker compose -f test/overleaf-ce/docker-compose.yml up -d    # first start takes a minute
npm run test:integration    # protocol, live editing (both doc formats), MCP end to end, browser sign-in, Git mode, local sync
npm run test:extension      # inside a real VS Code instance (downloads one into .vscode-test)
npm run test:vsix           # the same, against the packaged .vsix as installed
```

Press F5 in VS Code to launch an Extension Development Host.

---

## Troubleshooting

- **"Not signed in … or the session has expired"** — sign in again from the panel (sessions expire after a few days without use).
- **Browser sign-in doesn't open** — set `overleafMcp.browserPath` to Chrome, Edge, Brave or Chromium, or use **Paste a session cookie**.
- **Port 39847 in use** — change `overleafMcp.mcp.httpServer.port`; stdio clients are unaffected.
- **"Overleaf asked for a captcha"** — password sign-in is blocked on overleaf.com; use the browser sign-in.
- **Rate limited** — Overleaf limits logins (10 per 2 minutes) and project downloads (10 per minute per project); the tools back off and retry.

---

## Citation

If you use this software in your research, please cite:

```
@software{overleaf_mcp_2025,
  author = {GhoshSrinjoy},
  title = {Overleaf MCP Server},
  year = {2025},
  url = {https://github.com/GhoshSrinjoy/Overleaf-mcp}
}
```

## Skills

This project touches on: TypeScript, VS Code extension APIs (tree views, virtual file systems, secret storage, MCP registration), the Model Context Protocol, Overleaf's realtime protocol (socket.io 0.9) and operational transformation, three-way merging, ripgrep and BM25 search, LaTeX log parsing, the Chrome DevTools Protocol, Git, Docker, and testing against a real Overleaf server.

---

## Results & Business Recommendation

### What it delivers

- Every Overleaf project in your editor, editable live, with collaborators unaffected.
- AI assistants that can find, read, edit (or suggest), and compile across projects.
- No Redis, no per-project tokens, free plans included; Git tokens still work headless.

**Recommendation:** Use the **VS Code extension** day to day (it signs in, keeps the panel live and configures your assistants). Use **Docker or the CLI** on servers.

---

## Next Steps

🧾 Comments and review threads as MCP tools.
📦 Publish to the VS Code Marketplace and npm (`npx overleaf-mcp`).
🧠 Optional semantic (embedding) search on top of BM25.
🗂️ Project-wide find-and-replace with preview.

---
MIT License
