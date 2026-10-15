import * as path from 'node:path';
import * as vscode from 'vscode';
import { LogEntry } from '../core/latex/logParser';
import { BuildRef } from '../core/overleaf/types';
import { OverleafService } from '../core/service';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { overleafUri } from './overleafFs';

export interface CompileOptions {
  /** Faster compile that leaves images out. */
  draft?: boolean;
  stopOnFirstError?: boolean;
}

export interface CompileSnapshot {
  projectId: string;
  projectName: string;
  state: 'idle' | 'compiling' | 'done' | 'failed';
  /** Overleaf's status: success, failure, timedout, … */
  status?: string;
  pdf?: Uint8Array;
  /** Changes whenever a new PDF arrives; the preview reloads only then. */
  pdfVersion: number;
  /** The build the current PDF came from (SyncTeX lookups need it). */
  build?: BuildRef;
  rootPath?: string;
  errors: LogEntry[];
  warnings: LogEntry[];
  typesetting: LogEntry[];
  pages?: number;
  compiledAt?: number;
  /** Why the last compile produced no new PDF. */
  message?: string;
  rawLog?: string;
}

const OPTIONS_KEY = 'overleafMcp.compileOptions';
/** Overleaf refuses compiles that start within a second or two of the previous one. */
const MIN_AUTO_INTERVAL_MS = 4000;

/**
 * Runs Overleaf compiles for VS Code: one at a time per project (a request during a compile
 * queues one follow-up), results in the Problems panel, PDFs for the preview.
 */
export class CompileController implements vscode.Disposable {
  private readonly snapshots = new Map<string, CompileSnapshot>();
  private readonly running = new Map<string, Promise<CompileSnapshot>>();
  private readonly followUps = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastStart = new Map<string, number>();
  /** Files that have problems listed, per project, so the next compile can clear them. */
  private readonly diagnosed = new Map<string, vscode.Uri[]>();
  private readonly changed = new vscode.EventEmitter<CompileSnapshot>();
  readonly onDidChange = this.changed.event;
  readonly diagnostics = vscode.languages.createDiagnosticCollection('overleaf');

  constructor(
    private readonly service: OverleafService,
    private readonly state: vscode.Memento,
    private readonly logger: Logger,
    /** Local folder a project is synced to, so problems also show on the local copies. */
    private readonly localDir: (projectId: string) => Promise<string | undefined> = async () => undefined,
  ) {}

  get(projectId: string): CompileSnapshot | undefined {
    return this.snapshots.get(projectId);
  }

  isCompiling(projectId: string): boolean {
    return this.running.has(projectId);
  }

  options(projectId: string): CompileOptions {
    return this.state.get<Record<string, CompileOptions>>(OPTIONS_KEY, {})[projectId] ?? {};
  }

  async setOptions(projectId: string, options: CompileOptions): Promise<void> {
    const all = { ...this.state.get<Record<string, CompileOptions>>(OPTIONS_KEY, {}) };
    all[projectId] = { draft: !!options.draft, stopOnFirstError: !!options.stopOnFirstError };
    await this.state.update(OPTIONS_KEY, all);
    const snapshot = this.snapshots.get(projectId);
    if (snapshot) this.changed.fire(snapshot);
  }

  private update(projectId: string, patch: Partial<CompileSnapshot>): CompileSnapshot {
    const current = this.snapshots.get(projectId) ?? { projectId, projectName: projectId, state: 'idle', pdfVersion: 0, errors: [], warnings: [], typesetting: [] };
    const next = { ...current, ...patch };
    this.snapshots.set(projectId, next);
    this.changed.fire(next);
    return next;
  }

  /** Compiles now; if a compile is already running, one more runs right after it. */
  compile(projectId: string): Promise<CompileSnapshot> {
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    const running = this.running.get(projectId);
    if (running) {
      this.followUps.add(projectId);
      return running;
    }
    const task = this.run(projectId).finally(() => {
      this.running.delete(projectId);
      if (this.followUps.delete(projectId)) void this.compile(projectId);
    });
    this.running.set(projectId, task);
    return task;
  }

  /** Waits for running compiles to finish; compiles if that leaves no PDF. */
  async whenDone(projectId: string): Promise<CompileSnapshot> {
    for (let running = this.running.get(projectId); running; running = this.running.get(projectId)) await running;
    const snapshot = this.snapshots.get(projectId);
    return snapshot?.pdf ? snapshot : this.compile(projectId);
  }

  /** Debounced compile for automatic recompiles: waits until edits pause, and paces repeated compiles. */
  schedule(projectId: string, delayMs = 1500): void {
    clearTimeout(this.timers.get(projectId));
    const sinceLast = Date.now() - (this.lastStart.get(projectId) ?? 0);
    const delay = Math.max(delayMs, MIN_AUTO_INTERVAL_MS - sinceLast);
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.compile(projectId);
      }, delay),
    );
  }

  /** Cancels a scheduled compile and stops one that is running. */
  async stop(projectId: string): Promise<void> {
    this.followUps.delete(projectId);
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    if (this.running.has(projectId)) await this.service.stopCompile(projectId);
  }

  private async run(projectId: string): Promise<CompileSnapshot> {
    this.lastStart.set(projectId, Date.now());
    this.update(projectId, { state: 'compiling', message: undefined });
    try {
      const options = { ...this.options(projectId), fetchPdf: true };
      const result = await this.service.compile(projectId, options);
      const errors = [...result.log.errors, ...result.bibtex.filter((e) => e.level === 'error')];
      const warnings = [...result.log.warnings, ...result.bibtex.filter((e) => e.level === 'warning')];
      await this.publishDiagnostics(projectId, errors, warnings, result.log.typesetting);
      const previous = this.snapshots.get(projectId);
      const fresh = !!result.pdf;
      return this.update(projectId, {
        projectName: result.project.name,
        state: result.status === 'success' ? 'done' : 'failed',
        status: result.status,
        pdf: fresh ? result.pdf : previous?.pdf,
        pdfVersion: fresh ? (previous?.pdfVersion ?? 0) + 1 : previous?.pdfVersion ?? 0,
        build: fresh ? result.output.build : previous?.build,
        rootPath: fresh ? result.output.rootPath : previous?.rootPath,
        errors,
        warnings,
        typesetting: result.log.typesetting,
        pages: fresh ? result.log.pages : previous?.pages,
        compiledAt: Date.now(),
        rawLog: result.rawLog,
        message: describeStatus(result.status, fresh, errors.length),
      });
    } catch (error) {
      this.logger.warn(`Compile of ${projectId} failed`, error);
      return this.update(projectId, { state: 'failed', status: 'error', message: errorMessage(error) });
    }
  }

  private async publishDiagnostics(projectId: string, errors: LogEntry[], warnings: LogEntry[], typesetting: LogEntry[]): Promise<void> {
    const dir = await this.localDir(projectId).catch(() => undefined);
    const byFile = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    const add = (entry: LogEntry, severity: vscode.DiagnosticSeverity) => {
      if (!entry.file) return;
      const line = Math.max(0, (entry.line ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), entry.message, severity);
      diagnostic.source = 'Overleaf';
      const targets = [overleafUri(projectId, entry.file)];
      if (dir) targets.push(vscode.Uri.file(path.join(dir, entry.file)));
      for (const uri of targets) {
        const slot = byFile.get(uri.toString()) ?? { uri, list: [] };
        slot.list.push(diagnostic);
        byFile.set(uri.toString(), slot);
      }
    };
    for (const entry of errors) add(entry, vscode.DiagnosticSeverity.Error);
    for (const entry of warnings) add(entry, vscode.DiagnosticSeverity.Warning);
    for (const entry of typesetting) add(entry, vscode.DiagnosticSeverity.Information);
    for (const uri of this.diagnosed.get(projectId) ?? []) this.diagnostics.delete(uri);
    for (const { uri, list } of byFile.values()) this.diagnostics.set(uri, list);
    this.diagnosed.set(
      projectId,
      [...byFile.values()].map((slot) => slot.uri),
    );
  }

  /** Forgets everything (after signing out or switching accounts). */
  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.followUps.clear();
    this.snapshots.clear();
    this.diagnostics.clear();
    this.diagnosed.clear();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.changed.dispose();
    this.diagnostics.dispose();
  }
}

function describeStatus(status: string, freshPdf: boolean, errors: number): string | undefined {
  if (status === 'success') return undefined;
  const known: Record<string, string> = {
    failure: errors ? 'LaTeX stopped with errors, so no PDF was produced.' : 'The compile failed and produced no PDF. Check the raw log.',
    timedout: 'The compile timed out on Overleaf. Draft mode or a smaller document compiles faster.',
    terminated: 'The compile was stopped.',
    'too-recently-compiled': 'Overleaf compiled this project moments ago; try again in a few seconds.',
    'compile-in-progress': 'Another compile of this project is still running on Overleaf.',
    'project-too-large': 'The project is too large for Overleaf to compile.',
    'validation-problems': 'Overleaf found problems with the project files (for example, a file that is too large).',
    autocompile_backoff: 'Overleaf is pausing automatic compiles; use Recompile.',
    unavailable: 'The Overleaf compile servers are unavailable right now.',
    'rate-limited': 'Overleaf is limiting compiles right now; wait a minute and recompile.',
  };
  const text = known[status] ?? `The compile ended with status "${status}".`;
  return freshPdf ? `${text} Showing the PDF anyway.` : text;
}
