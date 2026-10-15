import { randomBytes } from 'node:crypto';
import { OverleafError, notLoggedIn } from '../util/errors';
import { Logger } from '../util/log';
import { HistoryOtTextOperation, OtOp, TrackedRange, assertEditableText, buildHistoryOtOperation, diffToOps, visibleContent } from './ot';
import { ProjectTree } from './projectTree';
import { SocketIoV0Client } from './socketio';
import { DocSnapshot, HistoryOtRaw, RawDoc, RawFileRef, RawFolder, RawProject } from './types';
import { OverleafWebClient, USER_AGENT } from './webClient';

export interface RemoteDocChange {
  docId: string;
  /** Doc version after the change. */
  version: number;
  /** True when the change was made through this connection (e.g. by an AI tool in this process). */
  local?: boolean;
}

export interface RealtimeListener {
  /** The folder tree changed (file added, removed, renamed or moved). */
  treeChanged?(): void;
  /** Someone else edited a doc. */
  docChanged?(change: RemoteDocChange): void;
  closed?(reason: string): void;
  /** A dropped connection was re-established; events may have been missed, so resync. */
  reconnected?(): void;
}

interface PendingAck {
  resolve: (version: number) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ApplyResult {
  /** Doc version after the update. */
  version: number;
  changed: boolean;
}

/** Decodes the UTF-8-bytes-as-Latin-1 strings Overleaf sends for sharejs docs. */
export function decodeWireLine(line: string): string {
  return Buffer.from(line, 'latin1').toString('utf8');
}

/**
 * One live connection to a project, the same one Overleaf's editor uses. The server joins the
 * project during the handshake and pushes the file tree; edits are sent as OT updates and
 * merged by the server with whatever collaborators are doing.
 */
export class RealtimeProject {
  readonly tree: ProjectTree;
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly listeners = new Set<RealtimeListener>();
  lastUsed = Date.now();

  private constructor(
    readonly projectId: string,
    readonly project: RawProject,
    readonly permissionsLevel: string,
    readonly publicId: string,
    private readonly socket: SocketIoV0Client,
    private readonly logger: Logger,
  ) {
    this.tree = new ProjectTree(project.rootFolder[0]);
    socket.onEvent((name, args) => this.handleEvent(name, args));
    socket.onClose((reason) => {
      for (const [, pending] of this.pendingAcks) {
        clearTimeout(pending.timer);
        pending.reject(new OverleafError('PROTOCOL', `Realtime connection closed before Overleaf confirmed the edit (${reason})`));
      }
      this.pendingAcks.clear();
      for (const listener of this.listeners) listener.closed?.(reason);
    });
  }

  static async connect(web: OverleafWebClient, projectId: string, logger: Logger): Promise<RealtimeProject> {
    try {
      return await RealtimeProject.connectAt(web, projectId, logger, await web.realtimeLocation(projectId));
    } catch (error) {
      // A 404 on the handshake means the server publishes its realtime endpoint elsewhere.
      if (error instanceof OverleafError && error.status === 404) {
        return RealtimeProject.connectAt(web, projectId, logger, await web.realtimeLocation(projectId, true));
      }
      throw error;
    }
  }

  private static async connectAt(
    web: OverleafWebClient,
    projectId: string,
    logger: Logger,
    location: { baseUrl: string; resource: string },
  ): Promise<RealtimeProject> {
    const socket = await SocketIoV0Client.connect({
      baseUrl: location.baseUrl,
      resource: location.resource,
      query: { projectId },
      jar: web.jar,
      userAgent: USER_AGENT,
      logger,
    });

    const joined = await new Promise<{ publicId: string; project: RawProject; permissionsLevel: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new OverleafError('TIMEOUT', 'Overleaf did not send the project after connecting'));
      }, 30_000);
      const stopEvents = socket.onEvent((name, args) => {
        if (name === 'joinProjectResponse') {
          dispose();
          resolve(args[0] as { publicId: string; project: RawProject; permissionsLevel: string });
        } else if (name === 'connectionRejected') {
          dispose();
          const error = (args[0] ?? {}) as { message?: string; code?: string };
          if (error.message === 'invalid session') reject(notLoggedIn(web.serverUrl));
          else if (error.code === 'ProjectNotFound') reject(new OverleafError('NOT_FOUND', `Project ${projectId} was not found`));
          else if (error.message === 'not authorized') reject(new OverleafError('FORBIDDEN', `You do not have access to project ${projectId}`));
          else if (error.code === 'TooManyRequests') reject(new OverleafError('RATE_LIMITED', 'Overleaf is rate limiting project connections; try again in a minute'));
          else reject(new OverleafError('PROTOCOL', `Overleaf rejected the connection: ${error.message ?? 'unknown reason'}`));
        }
      });
      const stopClose = socket.onClose((reason) => {
        dispose();
        reject(new OverleafError('PROTOCOL', `Realtime connection closed while joining the project (${reason})`));
      });
      const dispose = () => {
        clearTimeout(timer);
        stopEvents();
        stopClose();
      };
    }).catch((error) => {
      socket.close();
      throw error;
    });

    if (!joined.project?.rootFolder?.[0]) {
      socket.close();
      throw new OverleafError('PROTOCOL', 'Overleaf sent a project without a file tree');
    }
    logger.debug(`Joined project ${projectId} as ${joined.permissionsLevel}`);
    return new RealtimeProject(projectId, joined.project, joined.permissionsLevel, joined.publicId, socket, logger);
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  get canEdit(): boolean {
    return this.permissionsLevel === 'owner' || this.permissionsLevel === 'readAndWrite';
  }

  get canReview(): boolean {
    return this.canEdit || this.permissionsLevel === 'review';
  }

  addListener(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  private notifyTree(): void {
    for (const listener of this.listeners) listener.treeChanged?.();
  }

  private handleEvent(name: string, args: unknown[]): void {
    switch (name) {
      case 'otUpdateApplied': {
        const update = (args[0] ?? {}) as { doc?: string; v?: number; op?: unknown };
        if (!update.doc) return;
        if (update.op === undefined) {
          // The sender only gets {doc, v}: that is the acknowledgement of our own update.
          const pending = this.pendingAcks.get(update.doc);
          if (pending) {
            this.pendingAcks.delete(update.doc);
            clearTimeout(pending.timer);
            pending.resolve(update.v ?? 0);
          }
          return;
        }
        for (const listener of this.listeners) listener.docChanged?.({ docId: update.doc, version: (update.v ?? 0) + 1 });
        return;
      }
      case 'otUpdateError': {
        const [error, detail] = args as [unknown, { doc_id?: string } | undefined];
        const message = typeof error === 'string' ? error : (error as { message?: string })?.message ?? 'update rejected';
        const docId = detail?.doc_id;
        for (const [id, pending] of this.pendingAcks) {
          if (docId && id !== docId) continue;
          this.pendingAcks.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new OverleafError('CONFLICT', `Overleaf rejected the edit: ${message}`));
        }
        return;
      }
      case 'reciveNewDoc':
        this.tree.addEntity(String(args[0]), 'doc', args[1] as RawDoc);
        return this.notifyTree();
      case 'reciveNewFile':
        this.tree.addEntity(String(args[0]), 'file', args[1] as RawFileRef);
        return this.notifyTree();
      case 'reciveNewFolder':
        this.tree.addEntity(String(args[0]), 'folder', args[1] as RawFolder);
        return this.notifyTree();
      case 'removeEntity':
        this.tree.removeEntity(String(args[0]));
        return this.notifyTree();
      case 'reciveEntityRename':
        this.tree.renameEntity(String(args[0]), String(args[1]));
        return this.notifyTree();
      case 'reciveEntityMove':
        this.tree.moveEntity(String(args[0]), String(args[1]));
        return this.notifyTree();
      case 'rootDocUpdated':
        this.project.rootDoc_id = String(args[0]);
        return;
      case 'projectNameUpdated':
        this.project.name = String(args[0]);
        return;
      case 'forceDisconnect':
      case 'reconnectGracefully':
      case 'project:access:revoked':
        this.logger.info(`Overleaf asked to disconnect from project ${this.projectId} (${name})`);
        this.socket.close(name);
        return;
      default:
        return;
    }
  }

  /** Fetches the current text and version of a doc (this also authorizes later edits to it). */
  async readDoc(docId: string): Promise<DocSnapshot> {
    this.lastUsed = Date.now();
    const result = await this.socket.call('joinDoc', [docId, { encodeRanges: true, supportsHistoryOT: true }]);
    const [error, lines, version, , ranges, type] = result as [unknown, unknown, number, unknown, SharejsRanges | undefined, string | undefined];
    if (error) {
      const message = typeof error === 'string' ? error : (error as { message?: string }).message ?? JSON.stringify(error);
      throw new OverleafError(/not found/i.test(message) ? 'NOT_FOUND' : 'PROTOCOL', `Could not open the document: ${message}`);
    }
    if (type === 'history-ot') {
      const raw = lines as HistoryOtRaw;
      const deletes = trackedDeletes(raw);
      return {
        docId,
        type: 'history-ot',
        version,
        raw,
        text: visibleContent(raw.content, deletes),
        trackedChanges: raw.trackedChanges?.length ?? 0,
        comments: raw.comments?.length ?? 0,
      };
    }
    const text = (lines as string[]).map(decodeWireLine).join('\n');
    return {
      docId,
      type: 'sharejs-text-ot',
      version,
      text,
      trackedChanges: ranges?.changes?.length ?? 0,
      comments: ranges?.comments?.length ?? 0,
    };
  }

  /**
   * Sends the change from `snapshot.text` to `newText` as one OT update at `snapshot.version`
   * and waits until Overleaf confirms it was applied. The server transforms it against any edits
   * that collaborators made in between, so nothing they typed is lost.
   */
  async applyText(snapshot: DocSnapshot, newText: string, options: { track?: { userId: string } } = {}): Promise<ApplyResult> {
    this.lastUsed = Date.now();
    if (!this.canEdit && !(options.track && this.canReview)) {
      throw new OverleafError('FORBIDDEN', `You only have ${this.permissionsLevel} access to this project`);
    }
    assertEditableText(newText, 'Edit not applied');
    let update: { doc: string; op: OtOp[] | HistoryOtTextOperation[]; v: number; meta?: { tc: string } };
    if (snapshot.type === 'history-ot') {
      const raw = snapshot.raw!;
      const operation = buildHistoryOtOperation(raw.content.length, trackedDeletes(raw), snapshot.text, newText, options.track);
      if (!operation) return { version: snapshot.version, changed: false };
      update = { doc: snapshot.docId, op: [operation], v: snapshot.version };
    } else {
      const ops = diffToOps(snapshot.text, newText);
      if (!ops.length) return { version: snapshot.version, changed: false };
      update = { doc: snapshot.docId, op: ops, v: snapshot.version };
      // An id seed marks the update as a tracked change (Overleaf's "suggest" mode).
      if (options.track) update.meta = { tc: randomBytes(9).toString('hex') };
    }

    if (this.pendingAcks.has(snapshot.docId)) {
      throw new OverleafError('CONFLICT', 'Another edit to this document is still waiting for confirmation');
    }
    const acknowledged = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(snapshot.docId);
        reject(new OverleafError('TIMEOUT', 'Overleaf accepted the edit but did not confirm applying it within 60s'));
      }, 60_000);
      this.pendingAcks.set(snapshot.docId, { resolve, reject, timer });
    });
    // Avoid an unhandled rejection if the send itself fails below.
    acknowledged.catch(() => undefined);

    const [error] = (await this.socket.call('applyOtUpdate', [snapshot.docId, update]).catch((sendError) => {
      const pending = this.pendingAcks.get(snapshot.docId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(snapshot.docId);
      }
      throw sendError;
    })) as [unknown];
    if (error) {
      const pending = this.pendingAcks.get(snapshot.docId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(snapshot.docId);
      }
      const message = typeof error === 'string' ? error : (error as { message?: string }).message ?? JSON.stringify(error);
      throw new OverleafError(/not authorized/i.test(message) ? 'FORBIDDEN' : 'CONFLICT', `Overleaf rejected the edit: ${message}`);
    }
    const appliedAt = await acknowledged;
    // Overleaf only acknowledges our own edits, so tell local listeners (open editors) ourselves.
    for (const listener of this.listeners) listener.docChanged?.({ docId: snapshot.docId, version: appliedAt + 1, local: true });
    return { version: appliedAt + 1, changed: true };
  }
}

interface SharejsRanges {
  changes?: unknown[];
  comments?: unknown[];
}

function trackedDeletes(raw: HistoryOtRaw): TrackedRange[] {
  return (raw.trackedChanges ?? []).filter((tc) => tc.tracking?.type === 'delete').map((tc) => tc.range);
}
