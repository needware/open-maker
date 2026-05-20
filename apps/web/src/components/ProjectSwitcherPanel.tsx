// Recent-projects + open-folder switcher panel. Originally lived inside
// the fork's EntryView header (Cursor-style "Home" dropdown). Restored
// here as a standalone component so it can hang off any trigger — the
// current entry shell uses it from the left EntryNavRail "Open folder"
// button instead of a chrome header dropdown.
//
// UX shape (mirrors VS Code / Cursor's recent-projects popover):
//
//   ┌── Open a folder…          ─┐
//   │ [ search / paste path  ]   │
//   │                            │
//   │ Recents                    │
//   │   📁 ~/proj/foo            │
//   │   📁 ~/proj/bar            │
//   │   …                        │
//   ├────────────────────────────┤
//   │   📁 Open Folder…          │  ← native picker / in-app fallback
//   └────────────────────────────┘
//
// The search input doubles as a manual path fallback: pressing Enter on
// a query that doesn't match a recent entry treats the text as a path
// to open. `~/` is expanded client-side using the daemon-reported
// `homeDir` so users can paste `~/projects/foo` exactly as they would
// in a terminal.

import { useMemo, useState } from 'react';
import type { ImportFolderResponse } from '@open-design/contracts';
import type { RecentProjectEntry } from '../state/projects';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';
import { Icon } from './Icon';

interface Props {
  recentProjects: RecentProjectEntry[];
  homeDir: string;
  // Manual / recent-entry path import. Returning false (or void) is
  // treated as "stay open"; true closes the panel via `onClose`.
  onImportFolder: (path: string) => Promise<boolean> | boolean | Promise<void> | void;
  // Optional Electron-only secure folder pick + import handler. When
  // present the bottom "Open Folder…" row prefers it over `onOpenPicker`.
  onImportFolderResponse?: (response: ImportFolderResponse) => Promise<void> | void;
  // In-app `FolderPickerDialog` fallback for shells without
  // `window.electronAPI.pickAndImport` (browser dev, headless e2e,
  // distros without a native dialog).
  onOpenPicker?: () => void;
  onClose?: () => void;
}

export function ProjectSwitcherPanel({
  recentProjects,
  homeDir,
  onImportFolder,
  onImportFolderResponse,
  onOpenPicker,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasElectronPickAndImport =
    typeof window !== 'undefined' &&
    typeof window.electronAPI?.pickAndImport === 'function';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recentProjects;
    return recentProjects.filter((entry) => {
      const label = tildify(entry.path, homeDir).toLowerCase();
      return label.includes(q) || entry.path.toLowerCase().includes(q);
    });
  }, [query, recentProjects, homeDir]);

  async function handleOpenEntry(path: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onImportFolder(path);
      if (result !== false) onClose?.();
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    // Exact match against tildified label or absolute path → re-use the
    // canonical entry so we de-dupe against the daemon's realpath.
    const exact = recentProjects.find(
      (entry) =>
        tildify(entry.path, homeDir) === trimmed || entry.path === trimmed,
    );
    const target = exact ? exact.path : expandHome(trimmed, homeDir);
    setBusy(true);
    setError(null);
    try {
      const result = await onImportFolder(target);
      if (result !== false) {
        setQuery('');
        onClose?.();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handlePickFolder() {
    if (busy) return;
    if (hasElectronPickAndImport && onImportFolderResponse) {
      setBusy(true);
      setError(null);
      try {
        const result = await window.electronAPI!.pickAndImport!();
        if (!result || ('canceled' in result && result.canceled === true)) return;
        if (result.ok === true) {
          await onImportFolderResponse(result.response);
          onClose?.();
          return;
        }
        setError(formatPickAndImportFailure(result).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (onOpenPicker) {
      onClose?.();
      onOpenPicker();
    }
  }

  return (
    <div className="project-switcher-panel" data-testid="project-switcher-panel">
      <form onSubmit={handleSubmit} className="project-switcher-panel__search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Open a folder…"
          spellCheck={false}
          autoComplete="off"
          data-testid="project-switcher-input"
          disabled={busy}
          autoFocus
        />
      </form>

      {recentProjects.length > 0 ? (
        <div className="project-switcher-panel__section-label">Recents</div>
      ) : null}

      <div className="project-switcher-panel__list">
        {filtered.map((entry) => (
          <SwitcherRow
            key={entry.path}
            label={tildify(entry.path, homeDir)}
            title={entry.path}
            onClick={() => handleOpenEntry(entry.path)}
            disabled={busy}
          />
        ))}
        {recentProjects.length > 0 && filtered.length === 0 ? (
          <div className="project-switcher-panel__empty">
            No matches. Press Enter to open “{query.trim()}”.
          </div>
        ) : null}
        {recentProjects.length === 0 ? (
          <div className="project-switcher-panel__empty">
            No recent folders yet.
          </div>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="project-switcher-panel__error">
          {error}
        </div>
      ) : null}

      <div className="project-switcher-panel__foot">
        <SwitcherRow
          label={busy ? 'Opening…' : 'Open Folder…'}
          onClick={handlePickFolder}
          testId="project-switcher-pick"
          disabled={busy || (!hasElectronPickAndImport && !onOpenPicker)}
        />
      </div>
    </div>
  );
}

function SwitcherRow({
  label,
  title,
  onClick,
  testId,
  disabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="project-switcher-row"
      data-testid={testId ?? 'project-switcher-row'}
      onClick={onClick}
      title={title ?? label}
      disabled={disabled}
    >
      <Icon name="folder" size={14} />
      <span className="project-switcher-row__label">{label}</span>
    </button>
  );
}

// Convert an absolute path to its `~/`-prefixed display form when it
// lives under `homeDir`. Falls back to the raw path otherwise. Trailing
// slashes are normalized so `/Users/me/` and `/Users/me` both produce
// `~`. Inverse of `expandHome`.
export function tildify(absPath: string, homeDir: string): string {
  if (!absPath) return absPath;
  if (!homeDir) return absPath;
  const home = homeDir.replace(/[\\/]+$/, '');
  if (!home) return absPath;
  if (absPath === home) return '~';
  if (absPath.startsWith(home + '/')) return '~/' + absPath.slice(home.length + 1);
  if (absPath.startsWith(home + '\\')) return '~\\' + absPath.slice(home.length + 1);
  return absPath;
}

// Expand a leading `~` / `~/...` segment into an absolute path using the
// daemon-reported home dir. Inverse of `tildify`. Inputs that don't
// start with `~` are returned unchanged so absolute or workspace-
// relative paths still round-trip through `/api/projects/open`.
export function expandHome(input: string, homeDir: string): string {
  if (!input) return input;
  if (!homeDir) return input;
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return homeDir.replace(/[\\/]+$/, '') + input.slice(1);
  }
  return input;
}
