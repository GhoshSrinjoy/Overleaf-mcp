import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimePool } from '../../src/core/backends/realtimePool';
import { RealtimeListener, RealtimeProject } from '../../src/core/overleaf/realtime';
import { OverleafWebClient } from '../../src/core/overleaf/webClient';
import { silentLogger } from '../../src/core/util/log';

/** Stands in for a live connection: tracks listeners and can be closed like a dropped socket. */
class FakeProject {
  isOpen = true;
  readonly listeners = new Set<RealtimeListener>();
  addListener(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const listener of [...this.listeners]) listener.closed?.('closed');
  }
}

const web = {} as OverleafWebClient;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('RealtimePool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shares one reconnect between concurrent callers after a failed connect', async () => {
    const created: FakeProject[] = [];
    let attempt = 0;
    vi.spyOn(RealtimeProject, 'connect').mockImplementation(async () => {
      attempt++;
      await tick();
      if (attempt === 1) throw new Error('rate limited');
      const project = new FakeProject();
      created.push(project);
      return project as unknown as RealtimeProject;
    });
    const pool = new RealtimePool(web, silentLogger);
    const first = pool.get('p');
    const waiters = [pool.get('p'), pool.get('p'), pool.get('p')];
    await expect(first).rejects.toThrow('rate limited');
    const results = await Promise.allSettled(waiters);
    const projects = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<RealtimeProject>).value));
    expect(created).toHaveLength(1);
    expect(projects.size).toBeLessThanOrEqual(1);
    pool.closeAll();
  });

  it('attaches a listener exactly once when subscribing during a connect', async () => {
    const project = new FakeProject();
    vi.spyOn(RealtimeProject, 'connect').mockImplementation(async () => {
      await tick();
      return project as unknown as RealtimeProject;
    });
    const pool = new RealtimePool(web, silentLogger);
    const pending = pool.get('p');
    const docChanged = vi.fn();
    const unsubscribe = pool.subscribe('p', { docChanged });
    await pending;
    for (const listener of project.listeners) listener.docChanged?.({ docId: 'd', version: 2 });
    expect(docChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
    for (const listener of project.listeners) listener.docChanged?.({ docId: 'd', version: 3 });
    expect(docChanged).toHaveBeenCalledTimes(1);
    pool.closeAll();
  });

  it('refuses new connections after closeAll and closes ones still connecting', async () => {
    const project = new FakeProject();
    vi.spyOn(RealtimeProject, 'connect').mockImplementation(async () => {
      await tick();
      return project as unknown as RealtimeProject;
    });
    const pool = new RealtimePool(web, silentLogger);
    const pending = pool.get('p');
    pool.closeAll();
    await expect(pending).rejects.toThrow(/closed/);
    expect(project.isOpen).toBe(false);
    await expect(pool.get('p')).rejects.toThrow(/closed/);
  });

  it('reconnects subscribed projects after a drop and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const projects: FakeProject[] = [];
      vi.spyOn(RealtimeProject, 'connect').mockImplementation(async () => {
        const project = new FakeProject();
        projects.push(project);
        return project as unknown as RealtimeProject;
      });
      const pool = new RealtimePool(web, silentLogger);
      const reconnected = vi.fn();
      pool.subscribe('p', { reconnected });
      await pool.get('p');
      projects[0].close();
      await vi.advanceTimersByTimeAsync(1500);
      expect(projects).toHaveLength(2);
      expect(reconnected).toHaveBeenCalledTimes(1);
      expect(projects[1].listeners.size).toBeGreaterThan(0);
      pool.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
