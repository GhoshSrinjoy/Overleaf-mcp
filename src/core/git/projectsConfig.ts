import * as path from 'node:path';
import { readJsonFile } from '../util/fsx';

/** A project reached through Overleaf's Git bridge with a Git authentication token. */
export interface GitProjectConfig {
  key: string;
  name: string;
  projectId: string;
  gitToken: string;
}

interface ProjectsFile {
  projects?: Record<string, { name?: string; projectId?: string; gitToken?: string }>;
}

/**
 * Reads the projects.json format of the original server:
 *   { "projects": { "default": { "name": "My Paper", "projectId": "…", "gitToken": "…" } } }
 * plus the single-project fallback OVERLEAF_PROJECT_ID + OVERLEAF_GIT_TOKEN.
 */
export async function loadGitProjects(file: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<GitProjectConfig[]> {
  const projects: GitProjectConfig[] = [];
  if (file) {
    const data = await readJsonFile<ProjectsFile>(path.resolve(file));
    for (const [key, entry] of Object.entries(data?.projects ?? {})) {
      const projectId = entry.projectId?.trim();
      const gitToken = entry.gitToken?.trim() || env.OVERLEAF_GIT_TOKEN?.trim();
      if (!projectId || !gitToken || /^YOUR_/i.test(projectId)) continue;
      projects.push({ key, name: entry.name?.trim() || key, projectId, gitToken });
    }
  }
  const envId = env.OVERLEAF_PROJECT_ID?.trim();
  const envToken = env.OVERLEAF_GIT_TOKEN?.trim();
  if (envId && envToken && !projects.some((p) => p.projectId === envId)) {
    projects.push({ key: 'default', name: env.OVERLEAF_PROJECT_NAME?.trim() || envId, projectId: envId, gitToken: envToken });
  }
  return projects;
}
