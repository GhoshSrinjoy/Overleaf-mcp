import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sleep } from './concurrency';
import { OverleafError, isErrno } from './errors';

export interface FileLockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock whose holder stopped refreshing it for this long is assumed abandoned (holder crashed). */
  staleMs?: number;
}

interface Owner {
  pid: number;
  at: number;
  token: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

async function readOwner(lockDir: string): Promise<Owner | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')) as Owner;
  } catch {
    return undefined;
  }
}

async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(lockDir);
  if (owner) {
    if (Date.now() - owner.at > staleMs) return true;
    return owner.pid !== process.pid && !processAlive(owner.pid);
  }
  // Owner file missing: either it is being created right now or the holder died mid-create.
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > 5000;
  } catch {
    return false;
  }
}

/**
 * Cross-process lock built on atomic mkdir. Several MCP server processes (one per AI client)
 * and the VS Code extension share the cache directory, so refreshes must not interleave. The
 * holder refreshes its timestamp while working, and only ever removes a lock it still owns.
 */
export async function withFileLock<T>(lockDir: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      if (await isStale(lockDir, staleMs)) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new OverleafError('TIMEOUT', `Timed out waiting for lock ${path.basename(lockDir)}`);
      }
      await sleep(Math.min(50 * 2 ** Math.min(attempt, 4), 500));
    }
  }

  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const ownerFile = path.join(lockDir, 'owner.json');
  const writeOwner = () => fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now(), token } satisfies Owner));
  await writeOwner();
  const heartbeat = setInterval(() => {
    void readOwner(lockDir)
      .then((owner) => (owner?.token === token ? writeOwner() : undefined))
      .catch(() => undefined);
  }, Math.max(1000, Math.floor(staleMs / 4)));
  heartbeat.unref?.();

  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    if ((await readOwner(lockDir))?.token === token) await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
