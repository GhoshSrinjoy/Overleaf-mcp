import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readJsonFile } from '../util/fsx';
import { STATE_DIR } from './ignore';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A folder name derived from a project name that is valid everywhere and never "." or "..". */
export function safeFolderName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!safe || /^\.+$/.test(safe)) safe = 'project';
  if (RESERVED.test(safe)) safe = `${safe}_`;
  return safe;
}

/**
 * Why `dir` must not be used for syncing `projectId`, or undefined if it is fine: it must be new,
 * empty, or already synced with this same project. Anything else would upload unrelated files.
 */
export async function folderProblem(dir: string, projectId: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const state = await readJsonFile<{ projectId?: string }>(path.join(dir, STATE_DIR, 'state.json'));
  if (state?.projectId) return state.projectId === projectId ? undefined : 'it is already synced with a different Overleaf project';
  if (entries.filter((e) => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(e)).length) {
    return 'it is not empty (its files would all be uploaded to Overleaf)';
  }
  return undefined;
}
