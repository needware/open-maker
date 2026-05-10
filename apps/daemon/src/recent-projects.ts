// Recent-projects list — the only cross-project state the daemon owns.
//
// File: ~/.open-design/recent-projects.json
//
// Per RFC `project-as-unit.md` invariant #4 ("projects do not see each
// other"), this list is *not* a context source — it never enters compose,
// never gets shipped to an agent. It exists only so the UI can render a
// "Recent" picker on the home screen. Stale entries (paths that no longer
// resolve to a directory) are pruned on read.
//
// Format (versioned so we can bump if the shape ever changes):
//
//   { "version": 1, "entries": [{ "path": "/abs/realpath", "lastOpenedAt": 1717000000000 }, ...] }
//
// Ordering: most recently opened first. `addRecent()` re-inserts on each
// open so a re-opened project floats to the top.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local copies of the contract shapes. Mirrors `RecentProjectEntry` and
// `RecentProjectsResponse` in `packages/contracts/src/api/project-as-unit.ts`
// — duplicated here because the daemon's NodeNext resolution can't follow
// re-exports through the contracts barrel for types-only sub-modules
// (esbuild only emits `.mjs` for the entry points listed in
// `packages/contracts/esbuild.config.mjs`). The shapes are validated to stay
// in sync via the daemon's HTTP handlers, which serialize this module's
// output as `RecentProjectsResponse`.
//
// The `homeDir` field is daemon-side ergonomics: the web client uses it to
// tildify paths in the recents list ("/Users/me/proj" → "~/proj") to mirror
// Cursor's project switcher. The daemon already knows `os.homedir()`
// because the recent-projects file lives at `<home>/.open-design/recent-
// projects.json`, so surfacing it here costs one string and one membership
// check at request time.
interface RecentProjectEntry {
  path: string;
  lastOpenedAt?: number;
}

interface RecentProjectsResponse {
  entries: RecentProjectEntry[];
  /** Absolute path of the user's home directory (e.g. `/Users/me`). Used
   *  by the web UI to tildify paths in the recents list. */
  homeDir: string;
}

const RECENT_FILE_VERSION = 1 as const;
const MAX_RECENT_ENTRIES = 32;

/** Override the home dir lookup, for tests. */
let homeDirOverride: string | null = null;

export function setRecentProjectsHomeForTesting(dir: string | null): void {
  homeDirOverride = dir;
}

function recentDir(): string {
  return path.join(homeDirOverride ?? os.homedir(), '.open-design');
}

function recentFile(): string {
  return path.join(recentDir(), 'recent-projects.json');
}

interface OnDiskShape {
  version: number;
  entries: RecentProjectEntry[];
}

function isOnDiskShape(value: unknown): value is OnDiskShape {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number') return false;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every((e) => e && typeof e === 'object' && typeof (e as RecentProjectEntry).path === 'string');
}

async function readRaw(): Promise<OnDiskShape> {
  try {
    const buf = await fs.readFile(recentFile(), 'utf8');
    const parsed = JSON.parse(buf) as unknown;
    if (!isOnDiskShape(parsed)) return { version: RECENT_FILE_VERSION, entries: [] };
    if (parsed.version !== RECENT_FILE_VERSION) {
      // Future: branch to a migration. For now treat unknown versions as empty
      // so we never corrupt newer files (read-modify-write below would write
      // back as v1). Safer to start fresh.
      return { version: RECENT_FILE_VERSION, entries: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: RECENT_FILE_VERSION, entries: [] };
    }
    return { version: RECENT_FILE_VERSION, entries: [] };
  }
}

async function writeRaw(shape: OnDiskShape): Promise<void> {
  const dir = recentDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = recentFile() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8');
  await fs.rename(tmp, recentFile());
}

async function isExtantDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Add or refresh a project at the top of the list. */
export async function addRecent(realpath: string, now: number = Date.now()): Promise<void> {
  if (!path.isAbsolute(realpath)) throw new Error('addRecent requires an absolute realpath');
  const shape = await readRaw();
  const filtered = shape.entries.filter((e) => e.path !== realpath);
  filtered.unshift({ path: realpath, lastOpenedAt: now });
  await writeRaw({
    version: RECENT_FILE_VERSION,
    entries: filtered.slice(0, MAX_RECENT_ENTRIES),
  });
}

/**
 * Read the recent list and prune any entries whose paths no longer resolve
 * to a directory. Returns the live entries; persists the pruned list back to
 * disk only if anything was actually removed (avoids touching mtime).
 */
export async function listRecent(): Promise<RecentProjectsResponse> {
  const shape = await readRaw();
  const live: RecentProjectEntry[] = [];
  let pruned = 0;
  for (const entry of shape.entries) {
    if (await isExtantDir(entry.path)) {
      live.push(entry);
    } else {
      pruned += 1;
    }
  }
  if (pruned > 0) {
    await writeRaw({ version: RECENT_FILE_VERSION, entries: live }).catch(() => {
      // Pruning is best-effort; leaving the stale entry in place is fine.
    });
  }
  return { entries: live, homeDir: homeDirOverride ?? os.homedir() };
}

/** Remove a single entry. No-op if not present. */
export async function removeRecent(realpath: string): Promise<void> {
  const shape = await readRaw();
  const filtered = shape.entries.filter((e) => e.path !== realpath);
  if (filtered.length === shape.entries.length) return;
  await writeRaw({ version: RECENT_FILE_VERSION, entries: filtered });
}
