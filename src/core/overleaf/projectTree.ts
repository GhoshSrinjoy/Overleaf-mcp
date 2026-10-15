import { EntityType, RawDoc, RawFileRef, RawFolder, TreeEntry } from './types';

interface Located {
  type: EntityType;
  entity: RawDoc | RawFileRef | RawFolder;
  parent?: RawFolder;
}

/**
 * Mutable view of a project's folder tree, kept current from realtime events
 * (reciveNewDoc, removeEntity, …) and our own HTTP changes.
 */
export class ProjectTree {
  private index = new Map<string, Located>();

  constructor(readonly root: RawFolder) {
    root.docs ??= [];
    root.fileRefs ??= [];
    root.folders ??= [];
    this.reindex();
  }

  get rootFolderId(): string {
    return this.root._id;
  }

  private reindex(): void {
    this.index = new Map();
    const visit = (folder: RawFolder, parent?: RawFolder) => {
      folder.docs ??= [];
      folder.fileRefs ??= [];
      folder.folders ??= [];
      this.index.set(folder._id, { type: 'folder', entity: folder, parent });
      for (const doc of folder.docs) this.index.set(doc._id, { type: 'doc', entity: doc, parent: folder });
      for (const file of folder.fileRefs) this.index.set(file._id, { type: 'file', entity: file, parent: folder });
      for (const child of folder.folders) visit(child, folder);
    };
    visit(this.root);
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** All docs, files and folders (except the root) with their paths, sorted by path. */
  entries(): TreeEntry[] {
    const out: TreeEntry[] = [];
    const visit = (folder: RawFolder, prefix: string) => {
      for (const child of folder.folders) {
        const path = `${prefix}${child.name}`;
        out.push({ path, type: 'folder', id: child._id, name: child.name, parentId: folder._id });
        visit(child, `${path}/`);
      }
      for (const doc of folder.docs) out.push({ path: `${prefix}${doc.name}`, type: 'doc', id: doc._id, name: doc.name, parentId: folder._id });
      for (const file of folder.fileRefs) {
        out.push({ path: `${prefix}${file.name}`, type: 'file', id: file._id, name: file.name, parentId: folder._id, hash: file.hash });
      }
    };
    visit(this.root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  pathOf(id: string): string | undefined {
    if (id === this.root._id) return '';
    const located = this.index.get(id);
    if (!located) return undefined;
    const names: string[] = [];
    let current: Located | undefined = located;
    while (current && current.entity !== this.root) {
      names.unshift(current.entity.name);
      current = current.parent ? this.index.get(current.parent._id) : undefined;
    }
    return names.join('/');
  }

  find(path: string): TreeEntry | undefined {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return undefined;
    let folder = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = folder.folders.find((f) => f.name === parts[i]);
      if (!next) return undefined;
      folder = next;
    }
    const name = parts[parts.length - 1];
    const prefix = parts.slice(0, -1).join('/');
    const full = prefix ? `${prefix}/${name}` : name;
    const sub = folder.folders.find((f) => f.name === name);
    if (sub) return { path: full, type: 'folder', id: sub._id, name, parentId: folder._id };
    const doc = folder.docs.find((d) => d.name === name);
    if (doc) return { path: full, type: 'doc', id: doc._id, name, parentId: folder._id };
    const file = folder.fileRefs.find((f) => f.name === name);
    if (file) return { path: full, type: 'file', id: file._id, name, parentId: folder._id, hash: file.hash };
    return undefined;
  }

  folderId(path: string): string | undefined {
    if (!path.split('/').filter(Boolean).length) return this.root._id;
    const entry = this.find(path);
    return entry?.type === 'folder' ? entry.id : undefined;
  }

  addEntity(parentId: string, type: EntityType, entity: RawDoc | RawFileRef | RawFolder): void {
    if (this.index.has(entity._id)) return;
    const parent = this.index.get(parentId);
    if (!parent || parent.type !== 'folder') return;
    const folder = parent.entity as RawFolder;
    if (type === 'doc') folder.docs.push({ _id: entity._id, name: entity.name });
    else if (type === 'file') folder.fileRefs.push(entity as RawFileRef);
    else {
      const raw = entity as RawFolder;
      folder.folders.push({ _id: raw._id, name: raw.name, docs: raw.docs ?? [], fileRefs: raw.fileRefs ?? [], folders: raw.folders ?? [] });
    }
    this.reindex();
  }

  removeEntity(id: string): void {
    const located = this.index.get(id);
    if (!located?.parent) return;
    const parent = located.parent;
    parent.docs = parent.docs.filter((d) => d._id !== id);
    parent.fileRefs = parent.fileRefs.filter((f) => f._id !== id);
    parent.folders = parent.folders.filter((f) => f._id !== id);
    this.reindex();
  }

  renameEntity(id: string, name: string): void {
    const located = this.index.get(id);
    if (located) located.entity.name = name;
  }

  moveEntity(id: string, folderId: string): void {
    const located = this.index.get(id);
    const target = this.index.get(folderId);
    if (!located?.parent || !target || target.type !== 'folder') return;
    this.removeEntity(id);
    this.addEntity(folderId, located.type, located.entity);
  }
}
