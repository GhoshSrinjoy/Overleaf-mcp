import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Redis from 'ioredis';
import { Queue, Worker, QueueEvents } from 'bullmq';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OverleafGitClient from './overleaf-git-client.js';

// ES modules don't have __dirname, so we need to recreate it
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rest of your code stays the same...
const PROJECTS_FILE = process.env.PROJECTS_FILE
  ? path.resolve(process.cwd(), process.env.PROJECTS_FILE)
  : path.join(__dirname, 'projects.json');

const TEMP_DIR = process.env.OVERLEAF_TEMP_DIR
  ? path.resolve(process.cwd(), process.env.OVERLEAF_TEMP_DIR)
  : path.join(__dirname, 'temp');

const REQUEST_QUEUE_NAME = process.env.REQUEST_QUEUE_NAME || 'overleaf-mcp-requests';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10) || 120000;
const WORKER_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.REQUEST_CONCURRENCY || '4', 10) || 4,
);
const PROJECT_LOCK_TTL_MS = Number.parseInt(process.env.PROJECT_LOCK_TTL_MS || '60000', 10) || 60000;
const PROJECT_LOCK_RETRY_MS = Number.parseInt(process.env.PROJECT_LOCK_RETRY_MS || '200', 10) || 200;
const PROJECT_LOCK_MAX_WAIT_MS = Number.parseInt(
  process.env.PROJECT_LOCK_MAX_WAIT_MS || String(DEFAULT_TIMEOUT_MS),
  10,
) || DEFAULT_TIMEOUT_MS;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProjectsConfig() {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Failed to load projects config from ${PROJECTS_FILE}: ${err.message}`);
    }
    return { projects: {} };
  }
}

function getProjectsMap(config) {
  if (config && typeof config.projects === 'object') {
    return config.projects;
  }
  return {};
}

function resolveRedisConnection() {
  if (process.env.REDIS_URL) {
    return { url: process.env.REDIS_URL };
  }

  const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10) || 6379,
  };

  if (process.env.REDIS_PASSWORD) {
    connection.password = process.env.REDIS_PASSWORD;
  }

  if (process.env.REDIS_DB) {
    connection.db = Number.parseInt(process.env.REDIS_DB, 10) || 0;
  }

  return connection;
}

function createRedisClient(connectionConfig) {
  if (connectionConfig.url) {
    return new Redis(connectionConfig.url);
  }

  return new Redis({ ...connectionConfig });
}

function resolveProjectContext(args = {}) {
  const projectsConfig = loadProjectsConfig();
  const projects = getProjectsMap(projectsConfig);

  const requestedKey = args.projectName || 'default';
  const projectConfig = projects[requestedKey];

  const gitToken = args.gitToken || projectConfig?.gitToken || process.env.OVERLEAF_GIT_TOKEN;
  const projectId = args.projectId || projectConfig?.projectId || process.env.OVERLEAF_PROJECT_ID;

  if (!gitToken || !projectId) {
    throw new Error('Git token and project ID are required. Supply them via projects.json, tool arguments, or environment variables.');
  }

  const projectLabel = projectConfig?.name || requestedKey;

  return {
    projectKey: requestedKey,
    projectLabel,
    projectConfig,
    gitToken,
    projectId,
    client: new OverleafGitClient(gitToken, projectId, TEMP_DIR),
  };
}

const redisConnection = resolveRedisConnection();
const lockRedis = createRedisClient(redisConnection);
lockRedis.on('error', (err) => {
  console.error('Redis lock client error', err);
});

const lockClientReady = (async () => {
  if (lockRedis.status === 'ready') {
    return;
  }

  await new Promise((resolve) => {
    lockRedis.once('ready', resolve);
  });
})();

async function withProjectLock(projectId, handler) {
  await lockClientReady;

  if (!projectId) {
    throw new Error('Project ID is required to acquire lock');
  }

  const lockKey = `overleaf:lock:${projectId}`;
  const lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const releaseScript =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const startTime = Date.now();

  while (true) {
    const acquired = await lockRedis.set(lockKey, lockToken, 'NX', 'PX', PROJECT_LOCK_TTL_MS);
    if (acquired === 'OK') {
      break;
    }

    if (Date.now() - startTime > PROJECT_LOCK_MAX_WAIT_MS) {
      throw new Error(`Timed out waiting for lock on project ${projectId}`);
    }

    await wait(PROJECT_LOCK_RETRY_MS);
  }

  try {
    return await handler();
  } finally {
    try {
      await lockRedis.eval(releaseScript, 1, lockKey, lockToken);
    } catch (err) {
      console.warn(`Failed to release lock for project ${projectId}: ${err.message}`);
    }
  }
}

async function executeTool(name, args = {}) {
  switch (name) {
    case 'list_projects': {
      const projects = getProjectsMap(loadProjectsConfig());
      const projectList = Object.entries(projects).map(([key, project]) => `• ${key}: ${project.name || 'Unnamed'} (${project.projectId || 'missing projectId'})`);

      return {
        content: [{
          type: 'text',
          text: `Available Projects:\n\n${projectList.join('\n') || 'No projects configured in projects.json'}`,
        }],
      };
    }

    case 'list_files': {
      const { client, projectId } = resolveProjectContext(args);
      return withProjectLock(projectId, async () => {
        const files = await client.listFiles(args.extension || '.tex');
        return {
          content: [{
            type: 'text',
            text: `Files found: ${files.length}\n\n${files.map((f) => `• ${f}`).join('\n')}`,
          }],
        };
      });
    }

    case 'read_file': {
      if (!args.filePath) {
        throw new Error('filePath is required');
      }
      const { client, projectId } = resolveProjectContext(args);
      return withProjectLock(projectId, async () => {
        const content = await client.readFile(args.filePath);
        return {
          content: [{
            type: 'text',
            text: `File: ${args.filePath}\nSize: ${content.length} characters\n\n${content}`,
          }],
        };
      });
    }

    case 'get_sections': {
      if (!args.filePath) {
        throw new Error('filePath is required');
      }
      const { client, projectId } = resolveProjectContext(args);
      return withProjectLock(projectId, async () => {
        const sections = await client.getSections(args.filePath);
        const sectionSummary = sections
          .map(
            (s, i) => `${i + 1}. [${s.type}] ${s.title}\n   Content preview: ${s.content.substring(0, 100).replace(/\s+/g, ' ')}...`,
          )
          .join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `Sections in ${args.filePath} (${sections.length} total):\n\n${sectionSummary}`,
          }],
        };
      });
    }

    case 'get_section_content': {
      if (!args.filePath) {
        throw new Error('filePath is required');
      }
      if (!args.sectionTitle) {
        throw new Error('sectionTitle is required');
      }
      const { client, projectId } = resolveProjectContext(args);
      return withProjectLock(projectId, async () => {
        const section = await client.getSection(args.filePath, args.sectionTitle);
        if (!section) {
          throw new Error(`Section "${args.sectionTitle}" not found`);
        }
        return {
          content: [{
            type: 'text',
            text: `Section: ${section.title}\nType: ${section.type}\nContent length: ${section.content.length} characters\n\n${section.content}`,
          }],
        };
      });
    }

    case 'status_summary': {
      const { client, projectLabel, projectId } = resolveProjectContext(args);
      return withProjectLock(projectId, async () => {
        const allFiles = await client.listFiles('.tex');
        let summary = `📄 ${projectLabel} Status Summary\n\n`;
        summary += `Project ID: ${projectId}\n`;
        summary += `Total .tex files: ${allFiles.length}\n`;
        summary += `Files: ${allFiles.join(', ')}\n\n`;

        if (allFiles.length > 0) {
          const mainFile = allFiles.find((f) => f.includes('main')) || allFiles[0];
          const sections = await client.getSections(mainFile);
          summary += `📋 Structure of ${mainFile}:\n`;
          summary += `Total sections: ${sections.length}\n\n`;

          sections.slice(0, 10).forEach((s, i) => {
            summary += `${i + 1}. [${s.type}] ${s.title}\n`;
          });

          if (sections.length > 10) {
            summary += `... and ${sections.length - 10} more sections\n`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: summary,
          }],
        };
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const requestQueue = new Queue(REQUEST_QUEUE_NAME, { connection: redisConnection });
const queueEvents = new QueueEvents(REQUEST_QUEUE_NAME, { connection: redisConnection });
queueEvents.on('error', (err) => {
  console.error('Queue events error', err);
});

const worker = new Worker(
  REQUEST_QUEUE_NAME,
  async (job) => executeTool(job.data.name, job.data.args || {}),
  {
    connection: redisConnection,
    concurrency: WORKER_CONCURRENCY,
  },
);

worker.on('error', (err) => {
  console.error('Queue worker error', err);
});

const queueEventsReady = queueEvents.waitUntilReady();

const server = new Server(
  {
    name: 'overleaf-mcp',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_files',
      description: 'List all files in an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          extension: { type: 'string', description: 'File extension filter (e.g., .tex)', default: '.tex' },
          projectName: { type: 'string', description: 'Project key (default, project2, etc.)' },
          gitToken: { type: 'string', description: 'Git token override (optional)' },
          projectId: { type: 'string', description: 'Project ID override (optional)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from an Overleaf project',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file' },
          projectName: { type: 'string', description: 'Project key (default, project2, etc.)' },
          gitToken: { type: 'string', description: 'Git token override (optional)' },
          projectId: { type: 'string', description: 'Project ID override (optional)' },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_sections',
      description: 'Get all sections from a LaTeX file',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the LaTeX file' },
          projectName: { type: 'string', description: 'Project key (default, project2, etc.)' },
          gitToken: { type: 'string', description: 'Git token override (optional)' },
          projectId: { type: 'string', description: 'Project ID override (optional)' },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_section_content',
      description: 'Get content of a specific section',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the LaTeX file' },
          sectionTitle: { type: 'string', description: 'Title of the section' },
          projectName: { type: 'string', description: 'Project key (default, project2, etc.)' },
          gitToken: { type: 'string', description: 'Git token override (optional)' },
          projectId: { type: 'string', description: 'Project ID override (optional)' },
        },
        required: ['filePath', 'sectionTitle'],
        additionalProperties: false,
      },
    },
    {
      name: 'status_summary',
      description: 'Get a summary of the project status using configured credentials',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project key (default, project2, etc.)' },
          gitToken: { type: 'string', description: 'Git token override (optional)' },
          projectId: { type: 'string', description: 'Project ID override (optional)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_projects',
      description: 'List all available projects from configuration',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    await queueEventsReady;
    const jobOptions = {
      removeOnComplete: true,
      removeOnFail: true,
    };

    if (typeof args?.priority === 'number') {
      jobOptions.priority = args.priority;
    }

    const job = await requestQueue.add(name, { name, args }, jobOptions);
    const result = await job.waitUntilFinished(queueEvents, DEFAULT_TIMEOUT_MS);
    return result;
  } catch (error) {
    const message = error?.message || error?.toString?.() || 'Unknown error occurred while processing tool request';
    return {
      content: [{
        type: 'text',
        text: `Error: ${message}`,
      }],
      isError: true,
    };
  }
});

async function main() {
  await queueEventsReady;
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start Overleaf MCP server', err);
});
