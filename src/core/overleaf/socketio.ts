import WebSocket from 'ws';
import { OverleafError } from '../util/errors';
import { Logger } from '../util/log';
import { CookieJar } from './cookies';

/**
 * Client for the socket.io 0.9 wire protocol, which Overleaf's realtime service still speaks.
 * Frames look like `type:id:endpoint:data`; we use connect (1), heartbeat (2), event (5),
 * ack (6), error (7) and disconnect (0).
 */
export interface SocketIoOptions {
  /** Server base URL, e.g. https://www.overleaf.com */
  baseUrl: string;
  /** socket.io resource path, default "socket.io". */
  resource?: string;
  query?: Record<string, string>;
  jar: CookieJar;
  userAgent: string;
  logger: Logger;
  timeoutMs?: number;
}

export type ServerEventHandler = (name: string, args: unknown[]) => void;

const FRAME = /^([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?$/;

export class SocketIoV0Client {
  private ws?: WebSocket;
  private nextAckId = 0;
  private readonly pendingAcks = new Map<number, { resolve: (args: unknown[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly eventHandlers = new Set<ServerEventHandler>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatTimeoutMs = 60_000;
  private closed = false;

  private constructor(private readonly options: SocketIoOptions) {}

  static async connect(options: SocketIoOptions): Promise<SocketIoV0Client> {
    const client = new SocketIoV0Client(options);
    await client.open();
    return client;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  private queryString(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ ...this.options.query, ...extra });
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  private async open(): Promise<void> {
    const { baseUrl, jar, userAgent, logger } = this.options;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const resource = (this.options.resource ?? 'socket.io').replace(/^\/+|\/+$/g, '');
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const handshakeUrl = new URL(`${resource}/1/${this.queryString({ t: String(Date.now()) })}`, base);

    const response = await fetch(handshakeUrl, {
      headers: { Cookie: jar.headerFor(handshakeUrl), Origin: base.origin, 'User-Agent': userAgent },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar.storeFromResponse(response.headers, handshakeUrl);
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new OverleafError('NOT_LOGGED_IN', `Realtime handshake rejected (${response.status}). The Overleaf session may have expired.`, { status: response.status });
    }
    if (!response.ok) {
      throw new OverleafError('PROTOCOL', `Realtime handshake failed with HTTP ${response.status}: ${body.slice(0, 200)}`, { status: response.status });
    }
    const [sid, heartbeat, , transports] = body.trim().split(':');
    if (!sid || !transports?.split(',').includes('websocket')) {
      throw new OverleafError('PROTOCOL', `Unexpected realtime handshake response: ${body.slice(0, 200)}`);
    }
    const heartbeatSeconds = Number(heartbeat);
    if (Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0) this.heartbeatTimeoutMs = heartbeatSeconds * 1000 + 15_000;

    const wsUrl = new URL(`${resource}/1/websocket/${sid}${this.queryString()}`, base);
    const cookieUrl = new URL(wsUrl.href);
    wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Cookie: jar.headerFor(cookieUrl), Origin: base.origin, 'User-Agent': userAgent },
        handshakeTimeout: timeoutMs,
      });
      this.ws = ws;
      let connected = false;
      const timer = setTimeout(() => {
        if (!connected) {
          ws.terminate();
          reject(new OverleafError('TIMEOUT', 'Timed out connecting to the Overleaf realtime service'));
        }
      }, timeoutMs);

      ws.on('message', (data) => {
        const frame = data.toString();
        if (!connected && frame.startsWith('1:')) {
          connected = true;
          clearTimeout(timer);
          this.armHeartbeatWatchdog();
          resolve();
          return;
        }
        this.handleFrame(frame);
      });
      ws.on('unexpected-response', (_request, res) => {
        clearTimeout(timer);
        reject(new OverleafError('PROTOCOL', `Realtime websocket upgrade failed with HTTP ${res.statusCode}`, { status: res.statusCode }));
      });
      ws.on('error', (error) => {
        logger.debug('Realtime websocket error', error);
        if (!connected) {
          clearTimeout(timer);
          reject(new OverleafError('PROTOCOL', `Could not open the Overleaf realtime connection: ${error.message}`, { cause: error }));
        }
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.shutdown(`socket closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`);
        if (!connected) reject(new OverleafError('PROTOCOL', 'Overleaf closed the realtime connection during setup'));
      });
    });
  }

  private armHeartbeatWatchdog(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.options.logger.warn('Realtime connection missed its heartbeat; closing it');
      this.close('heartbeat timeout');
    }, this.heartbeatTimeoutMs);
    this.heartbeatTimer.unref?.();
  }

  private handleFrame(frame: string): void {
    this.armHeartbeatWatchdog();
    const match = FRAME.exec(frame);
    if (!match) return;
    const [, type, , , , data = ''] = match;
    switch (type) {
      case '0':
        this.close('server disconnected');
        break;
      case '2':
        this.send('2::');
        break;
      case '5': {
        try {
          const event = JSON.parse(data) as { name: string; args?: unknown[] };
          for (const handler of this.eventHandlers) handler(event.name, event.args ?? []);
        } catch (error) {
          this.options.logger.debug('Ignoring malformed realtime event', error);
        }
        break;
      }
      case '6': {
        const plus = data.indexOf('+');
        const id = Number(plus === -1 ? data : data.slice(0, plus));
        const pending = this.pendingAcks.get(id);
        if (!pending) break;
        this.pendingAcks.delete(id);
        clearTimeout(pending.timer);
        try {
          pending.resolve(plus === -1 ? [] : (JSON.parse(data.slice(plus + 1)) as unknown[]));
        } catch (error) {
          pending.reject(error as Error);
        }
        break;
      }
      case '7':
        this.options.logger.warn(`Realtime protocol error: ${data}`);
        this.close(`protocol error: ${data}`);
        break;
      default:
        break;
    }
  }

  private send(frame: string): void {
    if (!this.isOpen) throw new OverleafError('PROTOCOL', 'The Overleaf realtime connection is closed');
    this.ws!.send(frame);
  }

  onEvent(handler: ServerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Fire-and-forget event. */
  emit(name: string, ...args: unknown[]): void {
    this.send(`5:::${JSON.stringify({ name, args })}`);
  }

  /** Event with an acknowledgement callback; resolves with the callback's arguments. */
  call(name: string, args: unknown[], timeoutMs = 60_000): Promise<unknown[]> {
    const id = ++this.nextAckId;
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new OverleafError('TIMEOUT', `Overleaf did not answer "${name}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pendingAcks.set(id, { resolve, reject, timer });
      try {
        this.send(`5:${id}+::${JSON.stringify({ name, args })}`);
      } catch (error) {
        clearTimeout(timer);
        this.pendingAcks.delete(id);
        reject(error);
      }
    });
  }

  close(reason = 'closed by client'): void {
    if (this.closed) return;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('0::');
    } catch {
      // already gone
    }
    this.ws?.close();
    this.shutdown(reason);
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.heartbeatTimer);
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new OverleafError('PROTOCOL', `Realtime connection closed: ${reason}`));
    }
    this.pendingAcks.clear();
    for (const handler of this.closeHandlers) handler(reason);
    this.eventHandlers.clear();
    this.closeHandlers.clear();
  }
}
