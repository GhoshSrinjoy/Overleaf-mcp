import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sleep } from './concurrency';
import { isErrno } from './errors';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Writes via a temp file + rename so readers never observe a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, data, mode !== undefined ? { mode } : undefined);
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  if (mode !== undefined && process.platform !== 'win32') {
    await fs.chmod(file, mode);
  }
}

/** Windows briefly locks files that antivirus or indexers are reading; retry those renames. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 8 || !isErrno(error, 'EPERM', 'EBUSY', 'EACCES')) throw error;
      await sleep(25 * (attempt + 1));
    }
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Lists files under `root` as forward-slash relative paths. */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

/**
 * Resolves a project-relative path inside `root`, rejecting anything that would escape it.
 * Accepts both `/` and `\` separators and an optional leading slash.
 */
export function resolveInside(root: string, relativePath: string): string {
  const cleaned = normalizeProjectPath(relativePath);
  const resolved = path.resolve(root, ...cleaned.split('/'));
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${relativePath}" escapes the project root`);
  }
  return resolved;
}

/** Normalizes user/AI supplied paths to Overleaf's form: forward slashes, no leading slash, no `.` segments. */
export function normalizeProjectPath(input: string): string {
  const parts: string[] = [];
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`Path "${input}" escapes the project root`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}
