import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isErrno } from '../util/errors';
import { STATE_DIR } from './ignore';

const HEARTBEAT_MS = 10_000;
const STALE_MS = 35_000;

interface Owner {
  pid: number;
  at: number;
  holder: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

/**
 * Makes sure only one process (one VS Code window, or one CLI) syncs a folder at a time. The
 * holder refreshes the lease; others can take over once it goes stale.
 */
export class MirrorLease {
  private timer?: NodeJS.Timeout;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly holder: string,
  ) {
    this.file = path.join(dir, STATE_DIR, 'owner.json');
  }

  async currentOwner(): Promise<Owner | undefined> {
    try {
      const owner = JSON.parse(await fs.readFile(this.file, 'utf8')) as Owner;
      if (Date.now() - owner.at > STALE_MS || !alive(owner.pid)) return undefined;
      return owner;
    } catch {
      return undefined;
    }
  }

  /** Takes the lease if it is free (or ours); returns false when another live process holds it. */
  async acquire(): Promise<boolean> {
    const owner = await this.currentOwner();
    if (owner && !(owner.pid === process.pid && owner.holder === this.holder)) return false;
    await this.write();
    // Re-read: if another process raced us, the last writer wins and the other backs off.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const confirmed = await this.currentOwner();
    if (!confirmed || confirmed.pid !== process.pid || confirmed.holder !== this.holder) return false;
    this.timer = setInterval(() => void this.write().catch(() => undefined), HEARTBEAT_MS);
    this.timer.unref?.();
    return true;
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ pid: process.pid, at: Date.now(), holder: this.holder } satisfies Owner));
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    const owner = await this.currentOwner();
    if (owner?.pid === process.pid && owner.holder === this.holder) await fs.rm(this.file, { force: true });
  }
}
