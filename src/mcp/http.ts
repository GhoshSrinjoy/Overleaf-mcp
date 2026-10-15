import { timingSafeEqual } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Logger } from '../core/util/log';

export interface HttpHostOptions {
  port: number;
  /** Interface to bind; loopback by default so only this machine can connect. */
  host?: string;
  /** Required bearer token. */
  token: string;
  createServer: () => McpServer;
  logger: Logger;
}

export interface HttpHost {
  url: string;
  port: number;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const supplied = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Streamable-HTTP MCP endpoint at http://127.0.0.1:<port>/mcp. Stateless: every request gets a
 * fresh MCP server bound to the shared service, so there are no sessions to leak or expire.
 */
export async function startHttpHost(options: HttpHostOptions): Promise<HttpHost> {
  const host = options.host ?? '127.0.0.1';
  let port = options.port;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== '/mcp') return reply(res, 404, 'Not found; the MCP endpoint is /mcp');
    // Browsers attach an Origin header; local MCP clients don't. Refuse web pages outright.
    if (req.headers.origin) return reply(res, 403, 'Cross-origin requests are not allowed');
    if (!tokenMatches(req.headers.authorization, options.token)) return reply(res, 401, 'Missing or invalid bearer token');
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return reply(res, 405, 'This server is stateless; only POST is supported');
    }

    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`],
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      options.logger.error('MCP HTTP request failed', error);
      reply(res, 500, 'Internal server error');
    }
  };

  const httpServer: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`;
  options.logger.info(`MCP HTTP endpoint listening on ${url}`);
  return {
    url,
    port,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
