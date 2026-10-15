import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OverleafService } from '../core/service';
import { Logger } from '../core/util/log';
import { SERVER_INSTRUCTIONS, registerTools } from './tools';

export const SERVER_NAME = 'overleaf';
export const SERVER_VERSION = '2.1.0';

/** One MCP server instance (cheap: the service and its live connections are shared). */
export function createMcpServer(service: OverleafService, logger: Logger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } });
  registerTools(server, service, logger);
  return server;
}
