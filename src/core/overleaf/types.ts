export interface OverleafUserRef {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/** One entry of the project dashboard (POST /api/project). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** ISO timestamp. */
  lastUpdated?: string;
  lastUpdatedBy?: OverleafUserRef | null;
  owner?: OverleafUserRef | null;
  /** owner | readAndWrite | readWrite | review | readOnly */
  accessLevel?: string;
  /** owner | invite | token */
  source?: string;
  archived?: boolean;
  trashed?: boolean;
  tags?: string[];
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  projectIds: string[];
}

export interface SessionInfo {
  userId: string;
  email?: string;
  csrfToken: string;
}

/* ---------- realtime project model (joinProjectResponse) ---------- */

export interface RawDoc {
  _id: string;
  name: string;
}

export interface RawFileRef {
  _id: string;
  name: string;
  hash?: string;
  created?: string;
  linkedFileData?: unknown;
}

export interface RawFolder {
  _id: string;
  name: string;
  docs: RawDoc[];
  fileRefs: RawFileRef[];
  folders: RawFolder[];
}

export interface RawProject {
  _id: string;
  name: string;
  rootDoc_id?: string | null;
  mainBibliographyDoc_id?: string | null;
  rootFolder: RawFolder[];
  compiler?: string;
  imageName?: string;
  spellCheckLanguage?: string;
  owner?: { _id: string; email?: string; first_name?: string; last_name?: string };
  members?: Array<{ _id: string; email?: string; first_name?: string; last_name?: string; privileges?: string }>;
  trackChangesState?: boolean | Record<string, boolean>;
}

export type EntityType = 'doc' | 'file' | 'folder';

export interface TreeEntry {
  /** Project-relative path with forward slashes, no leading slash. */
  path: string;
  type: EntityType;
  id: string;
  name: string;
  /** Id of the folder that contains this entry. */
  parentId: string;
  /** Content hash for binary files. */
  hash?: string;
}

export type OtType = 'sharejs-text-ot' | 'history-ot';

export interface HistoryOtTrackedChange {
  range: { pos: number; length: number };
  tracking: { type: 'insert' | 'delete'; userId: string; ts: string };
}

export interface HistoryOtRaw {
  content: string;
  comments?: unknown[];
  trackedChanges?: HistoryOtTrackedChange[];
}

/** A document as fetched over the realtime connection at a specific version. */
export interface DocSnapshot {
  docId: string;
  type: OtType;
  version: number;
  /** What the user sees (tracked deletions removed). */
  text: string;
  /** Full stored content for history-ot docs (includes tracked deletions). */
  raw?: HistoryOtRaw;
  /** Pending tracked changes (suggestions) and comment threads anchored in the doc. */
  trackedChanges: number;
  comments: number;
}

export interface CompileOutputFile {
  path: string;
  url: string;
  type: string;
  build?: string;
}

/** Identifies one compile's output, as SyncTeX lookups need it. */
export interface BuildRef {
  editorId: string;
  buildId?: string;
  clsiServerId?: string;
}

/** A box in the PDF (points, measured from the page's top left). */
export interface PdfLocation {
  page: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface CodeLocation {
  file: string;
  line: number;
  column?: number;
}

export interface CompileResponse {
  status: string;
  outputFiles?: CompileOutputFile[];
  compileGroup?: string;
  clsiServerId?: string;
  pdfDownloadDomain?: string;
  validationProblems?: unknown;
  stats?: Record<string, unknown>;
  timings?: Record<string, unknown>;
}
