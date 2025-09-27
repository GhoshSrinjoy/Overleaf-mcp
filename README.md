# Overleaf MCP Server

An MCP (Model Context Protocol) server that provides access to Overleaf projects via Git integration. This allows Claude and other MCP clients to read LaTeX files, analyze document structure, and extract content from Overleaf projects.

## Features

- 📄 **File Management**: List and read files from Overleaf projects
- 📋 **Document Structure**: Parse LaTeX sections and subsections
- 🔍 **Content Extraction**: Extract specific sections by title
- 📊 **Project Summary**: Get overview of project status and structure
- 🏗️ **Multi-Project Support**: Manage multiple Overleaf projects
- ⚙️ **Redis Queue**: Dispatch requests through a Redis-backed job queue with per-project locking for safe parallelism

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your projects configuration:
   ```bash
   cp projects.example.json projects.json
   ```

4. Edit `projects.json` with your Overleaf credentials:
   ```json
   {
     "projects": {
       "default": {
         "name": "My Paper",
         "projectId": "YOUR_OVERLEAF_PROJECT_ID",
         "gitToken": "YOUR_OVERLEAF_GIT_TOKEN"
       }
     }
   }
   ```

5. Start a Redis instance (locally or remotely). For example:
   ```bash
   docker compose up redis -d
   ```

6. Run the MCP server:
   ```bash
   npm start
   ```

## Getting Overleaf Credentials

1. **Git Token**: 
   - Go to Overleaf Account Settings → Git Integration
   - Click "Create Token"

2. **Project ID**: 
   - Open your Overleaf project
   - Find it in the URL: `https://www.overleaf.com/project/[PROJECT_ID]`

## Configuration & Environment

The server coordinates all tool calls through a Redis-backed BullMQ queue. Heavy Git operations are serialized per project using Redis locks to avoid repository corruption while still allowing concurrent work across different projects.

Key environment variables:

- `PROJECTS_FILE`: Path to the Overleaf project map (default: `./projects.json`).
- `OVERLEAF_TEMP_DIR`: Cache directory for cloned repositories (default: `./temp`).
- `REDIS_URL` **or** `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`: Redis connection details.
- `REQUEST_QUEUE_NAME`: Override the BullMQ queue name (default: `overleaf-mcp-requests`).
- `REQUEST_CONCURRENCY`: Worker concurrency for queued jobs (default: `4`).
- `REQUEST_TIMEOUT_MS`: Maximum time the server waits for a job to finish (default: `120000`).
- `PROJECT_LOCK_TTL_MS`, `PROJECT_LOCK_RETRY_MS`, `PROJECT_LOCK_MAX_WAIT_MS`: Advanced tuning for per-project Redis locks.
- `OVERLEAF_GIT_TOKEN`, `OVERLEAF_PROJECT_ID`: Optional environment fallbacks if they are not defined in `projects.json` or tool arguments.

## Claude Desktop Setup

Add to your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux**: `~/.config/claude/claude_desktop_config.json`

### Option 1: Node.js Direct (Local Development)

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": [
        "/path/to/OverleafMCP/overleaf-mcp-server.js"
      ]
    }
  }
}
```

**Requirements**: Node.js installed locally, Redis running locally, all dependencies installed via `npm install`.

### Option 2: Docker Compose (Recommended for Production)

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "docker",
      "args": ["compose", "run", "--rm", "-T", "mcp"],
      "cwd": "/path/to/OverleafMCP"
    }
  }
}
```

**Requirements**: Docker and Docker Compose installed, project built with `docker compose build`.
**Benefits**: Isolated environment, automatic Redis management, ephemeral containers.

### Option 3: Docker Exec (Persistent Container)

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "docker",
      "args": ["exec", "-i", "CONTAINER_NAME", "node", "overleaf-mcp-server.js"]
    }
  }
}
```

**Example with specific container name**:
```json
{
  "mcpServers": {
    "overleaf": {
      "command": "docker",
      "args": ["exec", "-i", "overleaf_mcp-mcp-1", "node", "overleaf-mcp-server.js"]
    }
  }
}
```

**Requirements**: 
- Containers already running via `docker compose up -d`
- Replace `CONTAINER_NAME` with your actual container name (find with `docker ps`)
- Container must remain running for MCP to work

**When to use each approach**:
- **Option 1**: Development and debugging
- **Option 2**: Clean, isolated production deployments
- **Option 3**: When you want persistent containers and direct execution control

Restart Claude Desktop after configuration.

## Docker Usage

You can run the MCP server and its Redis dependency entirely in containers using the provided compose file.

### Basic Docker Setup

1. Copy `projects.example.json` to `projects.json` and fill in your credentials.
2. (Optional) Create a cache directory so clones persist across runs:
   ```bash
   mkdir -p data/cache
   ```
3. Build the containers:
   ```bash
   docker compose build
   ```
4. Start both Redis and MCP containers:
   ```bash
   docker compose up -d
   ```

### Advanced Docker Usage

**For ephemeral containers (Option 2 above)**:
```bash
# Start only Redis persistently
docker compose up -d redis

# MCP server will be started on-demand by Claude Desktop
```

**For persistent containers (Option 3 above)**:
```bash
# Start both services and keep them running
docker compose up -d

# Verify containers are running
docker compose ps

# Check container names for your configuration
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
```

The compose service maps `projects.json` into the container at `/app/projects.json`, and stores cloned repos under `./data/cache` on the host.

Use `docker compose down` when you want to stop all containers.

### Container Management

**View container logs**:
```bash
# MCP server logs
docker compose logs mcp

# Redis logs  
docker compose logs redis

# Follow logs in real-time
docker compose logs -f mcp
```

**Troubleshooting container names**:
```bash
# List all containers with names
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# If using Option 3, update your Claude config with the correct container name
```

## Available Tools

### `list_projects`
List all configured projects.

### `list_files`
List files in a project (default: .tex files).
- `extension`: File extension filter (optional)
- `projectName`: Project identifier (optional, defaults to "default")

### `read_file`
Read a specific file from the project.
- `filePath`: Path to the file (required)
- `projectName`: Project identifier (optional)

### `get_sections`
Get all sections from a LaTeX file.
- `filePath`: Path to the LaTeX file (required)
- `projectName`: Project identifier (optional)

### `get_section_content`
Get content of a specific section.
- `filePath`: Path to the LaTeX file (required)
- `sectionTitle`: Title of the section (required)
- `projectName`: Project identifier (optional)

### `status_summary`
Get a comprehensive project status summary.
- `projectName`: Project identifier (optional)

## Usage Examples

```
# List all projects
Use the list_projects tool

# Get project overview
Use status_summary tool

# Read main.tex file
Use read_file with filePath: "main.tex"

# Get Introduction section
Use get_section_content with filePath: "main.tex" and sectionTitle: "Introduction"

# List all sections in a file
Use get_sections with filePath: "main.tex"
```

## Multi-Project Usage

To work with multiple projects, add them to `projects.json`:

```json
{
  "projects": {
    "default": {
      "name": "Main Paper",
      "projectId": "project-id-1",
      "gitToken": "token-1"
    },
    "paper2": {
      "name": "Second Paper", 
      "projectId": "project-id-2",
      "gitToken": "token-2"
    }
  }
}
```

Then specify the project in tool calls:
```
Use get_section_content with projectName: "paper2", filePath: "main.tex", sectionTitle: "Methods"
```

## File Structure

```
OverleafMCP/
├── Dockerfile                 # Container image for the MCP server
├── docker-compose.yml         # Docker Compose stack (server + Redis)
├── overleaf-mcp-server.js     # Main MCP server with Redis-backed queue
├── overleaf-git-client.js     # Git client library
├── package.json               # Dependencies and scripts
├── package-lock.json          # Exact dependency versions
├── projects.example.json      # Configuration template (copy to projects.json)
├── README.md                  # Documentation
└── .dockerignore              # Docker build context exclusions
```

## Troubleshooting

### Common Issues

1. **"Server disconnected" in Claude Desktop**:
   - Check container names with `docker ps`
   - Verify containers are running with `docker compose ps`
   - Check Redis connection with `docker compose logs redis`

2. **"Project does not exist" error**:
   - Verify Project ID in your Overleaf URL
   - Check Git Token is valid and not expired
   - Ensure Git integration is enabled in Overleaf project settings

3. **Redis connection errors**:
   - Ensure Redis container is running: `docker compose up -d redis`
   - Check Redis logs: `docker compose logs redis`

4. **Container name mismatch (Option 3 users)**:
   - Find correct container name: `docker ps --format "table {{.Names}}"`
   - Update Claude Desktop config with exact container name
   - Container names may include project directory prefix (e.g., `overleaf_mcp-mcp-1`)

### Why Redis is Important

Redis provides several critical functions:

- **Queue Management**: Handles multiple simultaneous requests without blocking
- **Project Locking**: Prevents Git conflicts when multiple operations access the same project
- **Worker Pool Management**: Distributes workload across multiple worker processes
- **Production Readiness**: Makes the server scalable and robust for concurrent usage

Without Redis, the server would work for single-user scenarios but could face race conditions and resource exhaustion under load.

## Security Notes

- `projects.json` is gitignored to protect your credentials
- Never commit real project IDs or Git tokens
- Use the provided `projects.example.json` as a template
- Container logs may contain sensitive information - secure appropriately

## License

MIT License