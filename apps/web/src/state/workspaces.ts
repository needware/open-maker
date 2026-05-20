// Multi-folder workspaces — the "Set Up Workspace…" entry in the
// ProjectSwitcherPanel below "Open Folder…".
//
// Shape mirrors VS Code / Cursor's `.code-workspace` JSON: a named
// workspace is a list of folder paths plus a display name. One Agent
// session targets the primary folder; the remaining folders are
// surfaced as additional roots the user can flip to from the recent
// list.
//
// Persisted client-side via localStorage so the feature has zero
// daemon dependency for this first cut. A future daemon-backed
// version can read/write the same `.code-workspace` JSON shape from
// disk and migrate localStorage entries on first run.
//
// Storage key: `od.workspaces.v1`. The `v1` suffix lets future
// schema changes land without silently corrupting existing entries.

import { randomUUID } from '../utils/uuid';

const STORAGE_KEY = 'od.workspaces.v1';

export interface WorkspaceFolderRef {
  /** Absolute filesystem path the daemon can resolve. */
  path: string;
  /** Optional display name; falls back to the folder's basename. */
  name?: string;
}

export interface WorkspaceDef {
  id: string;
  name: string;
  folders: WorkspaceFolderRef[];
  /** Unix millis. */
  createdAt: number;
  /** Unix millis; null when the workspace has never been opened. */
  lastOpenedAt: number | null;
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isWorkspaceDef(value: unknown): value is WorkspaceDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WorkspaceDef>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.name !== 'string') return false;
  if (!Array.isArray(v.folders)) return false;
  for (const f of v.folders) {
    if (!f || typeof f !== 'object') return false;
    if (typeof (f as WorkspaceFolderRef).path !== 'string') return false;
  }
  if (typeof v.createdAt !== 'number') return false;
  if (v.lastOpenedAt !== null && typeof v.lastOpenedAt !== 'number') return false;
  return true;
}

export function listWorkspaces(): WorkspaceDef[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWorkspaceDef);
  } catch {
    return [];
  }
}

function writeAll(workspaces: WorkspaceDef[]): WorkspaceDef[] {
  const storage = safeStorage();
  if (!storage) return workspaces;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  } catch {
    // Quota / private-mode failures are non-fatal; the caller still
    // gets back the in-memory copy so the UI can render optimistically.
  }
  return workspaces;
}

export interface SaveWorkspaceInput {
  name: string;
  folders: WorkspaceFolderRef[];
}

/**
 * Create a new workspace definition. Duplicate folder paths are
 * dropped (last write wins) and at least one folder is required.
 * Returns null when the input is invalid so callers can surface a
 * validation error without throwing.
 */
export function saveWorkspace(input: SaveWorkspaceInput): WorkspaceDef | null {
  const folders = dedupeFolders(input.folders);
  if (folders.length === 0) return null;
  const name = input.name.trim().length > 0
    ? input.name.trim()
    : defaultWorkspaceName(folders);
  const def: WorkspaceDef = {
    id: randomUUID(),
    name,
    folders,
    createdAt: Date.now(),
    lastOpenedAt: null,
  };
  const next = [def, ...listWorkspaces()];
  writeAll(next);
  return def;
}

export function deleteWorkspace(id: string): void {
  const next = listWorkspaces().filter((w) => w.id !== id);
  writeAll(next);
}

export function touchWorkspace(id: string): WorkspaceDef | null {
  const all = listWorkspaces();
  let updated: WorkspaceDef | null = null;
  const next = all.map((w) => {
    if (w.id !== id) return w;
    updated = { ...w, lastOpenedAt: Date.now() };
    return updated;
  });
  if (!updated) return null;
  writeAll(next);
  return updated;
}

function dedupeFolders(folders: WorkspaceFolderRef[]): WorkspaceFolderRef[] {
  const seen = new Map<string, WorkspaceFolderRef>();
  for (const f of folders) {
    const path = f.path.trim();
    if (!path) continue;
    seen.set(path, { path, ...(f.name ? { name: f.name } : {}) });
  }
  return Array.from(seen.values());
}

function defaultWorkspaceName(folders: WorkspaceFolderRef[]): string {
  const primary = folders[0];
  if (!primary) return 'Untitled workspace';
  return primary.name?.trim() || basename(primary.path) || 'Untitled workspace';
}

export function basename(path: string): string {
  if (!path) return '';
  const stripped = path.replace(/[\\/]+$/, '');
  const idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return idx >= 0 ? stripped.slice(idx + 1) : stripped;
}

/**
 * Stable comparator: most-recently-opened first, falling back to
 * creation time. Mirrors how recent projects sort.
 */
export function compareByRecency(a: WorkspaceDef, b: WorkspaceDef): number {
  const aT = a.lastOpenedAt ?? a.createdAt;
  const bT = b.lastOpenedAt ?? b.createdAt;
  return bT - aT;
}
