import { OverleafError } from '../util/errors';
import { Logger } from '../util/log';
import { RealtimeListener, RealtimeProject } from '../overleaf/realtime';
import { OverleafWebClient } from '../overleaf/webClient';

interface PoolEntry {
  /** Resolves once the connection is open and every subscriber is attached. */
  ready: Promise<RealtimeProject>;
  project?: RealtimeProject;
  lastUsed: number;
  /** Subscriber → detach function, so each listener is attached to a connection exactly once. */
  attached: Map<RealtimeListener, () => void>;
  stopClosedWatch?: () => void;
}

const RECONNECT_DELAYS_MS = [1000, 3000, 10_000, 30_000, 60_000];

/**
 * Keeps realtime connections open per project and reuses them. Overleaf rate-limits joining a
 * project (45/min), and reconnecting per call would also be slow.
 */
export class RealtimePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly listeners = new Map<string, Set<RealtimeListener>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly sweeper: NodeJS.Timeout;
  private closedAll = false;

  constructor(
    private readonly web: OverleafWebClient,
    private readonly logger: Logger,
    private readonly idleMs = 5 * 60_000,
    private readonly maxConnections = 12,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  async get(projectId: string): Promise<RealtimeProject> {
    for (;;) {
      if (this.closedAll) throw new OverleafError('PROTOCOL', 'The Overleaf session was closed');
      const existing = this.entries.get(projectId);
      if (!existing) break;
      try {
        const project = await existing.ready;
        if (project.isOpen) {
          existing.lastUsed = Date.now();
          return project;
        }
      } catch {
        // failed to connect; replace it below unless someone already did
      }
      // Several callers may get here at once: only the first replaces the entry, the rest reuse it.
      if (this.entries.get(projectId) === existing) this.drop(projectId, existing);
    }

    const entry: PoolEntry = { ready: undefined as unknown as Promise<RealtimeProject>, lastUsed: Date.now(), attached: new Map() };
    entry.ready = RealtimeProject.connect(this.web, projectId, this.logger).then((project) => {
      if (this.closedAll || this.entries.get(projectId) !== entry) {
        project.close();
        throw new OverleafError('PROTOCOL', 'The Overleaf session was closed');
      }
      entry.project = project;
      entry.stopClosedWatch = project.addListener({
        closed: () => {
          if (this.entries.get(projectId) !== entry) return;
          this.drop(projectId, entry);
          // Someone is listening for live changes: get the connection back on our own.
          if (this.listeners.has(projectId)) this.scheduleReconnect(projectId, 0);
        },
      });
      for (const listener of this.listeners.get(projectId) ?? []) this.attach(projectId, entry, listener);
      this.evictOverflow();
      return project;
    });
    this.entries.set(projectId, entry);
    try {
      return await entry.ready;
    } catch (error) {
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
      throw error;
    }
  }

  private attach(projectId: string, entry: PoolEntry, listener: RealtimeListener): void {
    if (!entry.project || entry.attached.has(listener)) return;
    // Forward only while still subscribed, in case unsubscribing races a reconnect.
    const active = () => this.listeners.get(projectId)?.has(listener) ?? false;
    entry.attached.set(
      listener,
      entry.project.addListener({
        treeChanged: () => active() && listener.treeChanged?.(),
        docChanged: (change) => active() && listener.docChanged?.(change),
        closed: (reason) => active() && listener.closed?.(reason),
      }),
    );
  }

  private scheduleReconnect(projectId: string, attempt: number): void {
    if (this.closedAll || this.reconnectTimers.has(projectId)) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(projectId);
      if (this.closedAll || !this.listeners.has(projectId) || this.entries.has(projectId)) return;
      this.get(projectId).then(
        () => {
          this.logger.info(`Reconnected to project ${projectId}`);
          for (const listener of this.listeners.get(projectId) ?? []) listener.reconnected?.();
        },
        (error) => {
          this.logger.warn(`Reconnecting to project ${projectId} failed; retrying`, error);
          this.scheduleReconnect(projectId, attempt + 1);
        },
      );
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(projectId, timer);
  }

  /** Listens to a project's live events; also keeps its connection from idling out. */
  subscribe(projectId: string, listener: RealtimeListener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(listener);
    // A connection that is already open gets the listener now; one still connecting attaches it when ready.
    const entry = this.entries.get(projectId);
    if (entry) this.attach(projectId, entry, listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.listeners.delete(projectId);
      const current = this.entries.get(projectId);
      current?.attached.get(listener)?.();
      current?.attached.delete(listener);
    };
  }

  private drop(projectId: string, entry: PoolEntry): void {
    if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
    for (const detach of entry.attached.values()) detach();
    entry.attached.clear();
    entry.stopClosedWatch?.();
    void entry.ready.then((project) => project.close(), () => undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [projectId, entry] of this.entries) {
      if (this.listeners.has(projectId)) continue;
      if (now - entry.lastUsed > this.idleMs) this.drop(projectId, entry);
    }
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxConnections) return;
    const idle = [...this.entries].filter(([id]) => !this.listeners.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [projectId, entry] of idle.slice(0, this.entries.size - this.maxConnections)) this.drop(projectId, entry);
  }

  closeAll(): void {
    this.closedAll = true;
    clearInterval(this.sweeper);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const [projectId, entry] of [...this.entries]) this.drop(projectId, entry);
  }
}
