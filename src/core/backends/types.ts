import { BuildRef, CompileResponse, EntityType, OtType, ProjectSummary, Tag } from '../overleaf/types';
import { HistoryDiffResponse, HistoryUpdatesResponse } from '../overleaf/webClient';
import { SkippedFile } from '../store/snapshotCache';

export interface FileEntry {
  path: string;
  type: EntityType;
  id?: string;
  hash?: string;
}

export interface ProjectTreeInfo {
  entries: FileEntry[];
  rootDocPath?: string;
  permissionsLevel: string;
  canEdit: boolean;
}

export interface TextContent {
  text: string;
  version?: number;
  otType?: OtType;
  trackedChanges?: number;
  comments?: number;
}

export interface UpdateTextOptions {
  /** Record the change as a tracked change ("suggestion") instead of a direct edit. */
  track?: boolean;
  createIfMissing?: boolean;
  /** Commit message for backends that keep Git history. */
  message?: string;
}

export interface UpdateTextResult {
  path: string;
  created: boolean;
  changed: boolean;
  before: string;
  after: string;
  version?: number;
  via: 'realtime' | 'upload' | 'git';
}

export interface SnapshotFiles {
  files: Array<[string, Uint8Array]>;
  skipped: SkippedFile[];
  /** Identifier of what was downloaded (lastUpdated, commit hash). */
  version?: string;
}

/**
 * How the service reaches a project. The web session backend (default) talks to Overleaf like
 * the browser editor; the Git backend serves projects configured with Git tokens.
 */
export interface ProjectBackend {
  readonly kind: 'session' | 'git';
  listProjects(): Promise<ProjectSummary[]>;
  listTags(): Promise<Tag[]>;
  getTree(projectId: string): Promise<ProjectTreeInfo>;
  readText(projectId: string, path: string): Promise<TextContent>;
  readBinary(projectId: string, path: string): Promise<Uint8Array>;
  /** Read-modify-write of one text file; `mutate` may run again if the backend has to retry. */
  updateText(projectId: string, path: string, mutate: (current: string) => string, options?: UpdateTextOptions): Promise<UpdateTextResult>;
  writeBinary(projectId: string, path: string, data: Uint8Array): Promise<void>;
  createFolder(projectId: string, path: string): Promise<void>;
  deletePath(projectId: string, path: string): Promise<void>;
  movePath(projectId: string, from: string, to: string): Promise<void>;
  snapshot(projectId: string): Promise<SnapshotFiles>;
  /** Freshness key for cached snapshots; undefined means "unknown, use the cache age". */
  remoteVersion(project: ProjectSummary): Promise<string | undefined>;
  createProject?(name: string, template: 'none' | 'example'): Promise<string>;
  compile?(projectId: string, options: { rootPath?: string; draft?: boolean; stopOnFirstError?: boolean }): Promise<CompileOutput>;
  historyUpdates?(projectId: string, options: { minCount?: number; before?: number }): Promise<HistoryUpdatesResponse>;
  historyDiff?(projectId: string, path: string, from: number, to: number): Promise<HistoryDiffResponse>;
  close(): void;
}

export interface CompileOutput {
  response: CompileResponse;
  log?: string;
  bibtexLog?: string;
  pdf?: () => Promise<Uint8Array>;
  /** Identifies this build for SyncTeX lookups. */
  build: BuildRef;
  /** Main document the compile used, as a project path. */
  rootPath?: string;
}
