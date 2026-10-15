import * as path from 'node:path';
import { withFileLock } from '../util/fileLock';
import { readJsonFile, writeFileAtomic } from '../util/fsx';

/** Preferences shared between the extension and every MCP server process. */
export interface SharedSettings {
  /** Projects the user pinned for AI work; tools default to these when no project is named. */
  pinnedProjects: string[];
  /** ripgrep binary to use (the extension records the copy that ships with VS Code). */
  ripgrepPath?: string;
  /** Projects kept in sync with a local folder (two-way mirror). */
  mirrors?: Array<{ projectId: string; dir: string }>;
}

const EMPTY: SharedSettings = { pinnedProjects: [] };

export class SettingsStore {
  private cached?: { at: number; value: SharedSettings };

  constructor(private readonly file: string) {}

  /** Re-reads at most every `maxAgeMs` so pins made in VS Code reach running servers quickly. */
  async read(maxAgeMs = 2000): Promise<SharedSettings> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return this.cached.value;
    const data = await readJsonFile<Partial<SharedSettings>>(this.file);
    const value: SharedSettings = {
      ...EMPTY,
      ...data,
      pinnedProjects: Array.isArray(data?.pinnedProjects) ? data.pinnedProjects.filter((id) => typeof id === 'string') : [],
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async update(mutate: (settings: SharedSettings) => SharedSettings | void): Promise<SharedSettings> {
    return withFileLock(path.join(path.dirname(this.file), 'locks', 'settings.lock'), async () => {
      const current = await this.read(0);
      const next = mutate({ ...current, pinnedProjects: [...current.pinnedProjects] }) ?? current;
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.cached = { at: Date.now(), value: next };
      return next;
    });
  }
}
