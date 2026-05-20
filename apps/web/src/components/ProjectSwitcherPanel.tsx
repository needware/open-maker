// Recent-projects + open-folder switcher panel. Originally lived inside
// the fork's EntryView header (Cursor-style "Home" dropdown). Restored
// here as a standalone component so it can hang off any trigger — the
// current entry shell uses it from the left EntryNavRail "Open folder"
// button instead of a chrome header dropdown.
//
// The panel has two modes:
//
//   browse mode (default) — VS Code / Cursor's recent-projects popover:
//
//     ┌── Open a folder…          ─┐
//     │ [ search / paste path  ]   │
//     │ Recents                    │
//     │   📁 my-workspace          │  ← saved multi-folder workspaces
//     │       hover → folder paths │     are inlined here, labelled by
//     │   📁 ~/proj/foo            │     workspace name. Identical icon
//     │   …                        │     to plain folders; the hover
//     ├────────────────────────────┤     popover is the differentiator.
//     │   📁 Open Folder…          │
//     │   ▦  Set Up Workspace…     │  ← enters workspace mode
//     └────────────────────────────┘
//
//   workspace mode — Cursor's "Set Up Workspace" inline picker:
//
//     ┌── ‹  [Workspace Name]      ─┐  ← back arrow + name input
//     │ [ Filter folders…        ]  │
//     │   📁 ~/proj/foo         ✓   │  ← multi-select from recents +
//     │   📁 ~/proj/bar             │     ad-hoc additions
//     │ ├────────────────────────── │
//     │   ⊕  Add Folder             │  ← native picker, adds + selects
//     │   ✓  Create     Select ≥ 2  │  ← persists + opens workspace
//     └────────────────────────────┘
//
// The search input doubles as a manual path fallback: pressing Enter on
// a query that doesn't match a recent entry treats the text as a path
// to open. `~/` is expanded client-side using the daemon-reported
// `homeDir` so users can paste `~/projects/foo` exactly as they would
// in a terminal.

import { useEffect, useMemo, useState } from 'react';
import type { ImportFolderResponse } from '@open-design/contracts';
import type { RecentProjectEntry } from '../state/projects';
import {
  basename as workspaceBasename,
  saveWorkspace,
  type WorkspaceDef,
  type WorkspaceFolderRef,
} from '../state/workspaces';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';
import { openFolderDialog } from '../providers/registry';
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
  // Multi-folder workspaces — Cursor-style "Set Up Workspace". When
  // `onOpenWorkspace` is provided the panel renders the workspace
  // section above Recents and exposes the "Set Up Workspace…" row
  // (which switches the panel into the inline workspace-builder mode).
  workspaces?: WorkspaceDef[];
  onOpenWorkspace?: (workspace: WorkspaceDef) => Promise<boolean> | boolean | void | Promise<void>;
  onDeleteWorkspace?: (workspaceId: string) => void;
  // Notify the parent after the panel saves a new workspace so the
  // workspaces list can be refreshed for the next open.
  onWorkspacesChanged?: () => void;
  // Workspace-mode candidate pool. The panel union-merges these
  // with `recentProjects` paths so the "Set Up Workspace" picker
  // can show every folder the user has ever touched (imported
  // projects with a baseDir, not just the recent-N list). When
  // omitted the panel falls back to recents only. Browse-mode
  // "Recents" is unaffected.
  workspaceCandidatePaths?: string[];
  onClose?: () => void;
}

export function ProjectSwitcherPanel({
  recentProjects,
  homeDir,
  onImportFolder,
  onImportFolderResponse,
  onOpenPicker,
  workspaces,
  onOpenWorkspace,
  onDeleteWorkspace,
  onWorkspacesChanged,
  workspaceCandidatePaths,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workspace-builder inline mode. The panel toggles between the
  // default browse view and the workspace-setup view; workspace state
  // is local because exiting the mode (back arrow / cancel) should
  // discard the in-progress selection, exactly like Cursor's flow.
  const [mode, setMode] = useState<'browse' | 'workspace'>('browse');
  const [wsName, setWsName] = useState('');
  const [wsFilter, setWsFilter] = useState('');
  // Ordered: first entry is the workspace's primary root.
  const [wsSelected, setWsSelected] = useState<string[]>([]);
  // Paths added through the "Add Folder" native picker that aren't
  // present in `recentProjects`. Surfaced at the top of the candidate
  // list so the user can see what they just added without scrolling.
  const [wsExtra, setWsExtra] = useState<string[]>([]);

  function enterWorkspaceMode() {
    setMode('workspace');
    setWsName('');
    setWsFilter('');
    setWsSelected([]);
    setWsExtra([]);
    setError(null);
  }

  function exitWorkspaceMode() {
    setMode('browse');
    setError(null);
  }

  // Reset any in-progress workspace state when the panel closes (the
  // parent unmounts us, so this `useEffect` cleanup also covers it,
  // but a defensive reset when the panel itself transitions modes
  // keeps the state-machine clean).
  useEffect(() => {
    if (mode === 'browse') {
      setWsName('');
      setWsFilter('');
      setWsSelected([]);
      setWsExtra([]);
    }
  }, [mode]);

  const hasElectronPickAndImport =
    typeof window !== 'undefined' &&
    typeof window.electronAPI?.pickAndImport === 'function';

  // Map "primary folder path → workspace" so the Recents loop can
  // detect which entries are workspaces (Cursor inlines workspaces
  // into the unified Recents list — there's no separate "Workspaces"
  // section). Only the first folder of a workspace counts as primary
  // and gets added to `recent-projects.json` on open, so the
  // primary-path key is sufficient for identification.
  const workspaceByPrimaryPath = useMemo(() => {
    const map = new Map<string, WorkspaceDef>();
    for (const w of workspaces ?? []) {
      const primary = w.folders[0]?.path;
      if (primary) map.set(primary, w);
    }
    return map;
  }, [workspaces]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recentProjects;
    return recentProjects.filter((entry) => {
      const ws = workspaceByPrimaryPath.get(entry.path);
      const label = (ws?.name ?? tildify(entry.path, homeDir)).toLowerCase();
      // Workspaces also match against their constituent folder paths
      // so a query like "hostex" still surfaces a workspace whose
      // primary is named differently.
      if (ws) {
        const allPaths = ws.folders.map((f) => f.path.toLowerCase()).join(' ');
        if (allPaths.includes(q)) return true;
      }
      return label.includes(q) || entry.path.toLowerCase().includes(q);
    });
  }, [query, recentProjects, homeDir, workspaceByPrimaryPath]);

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

  async function handleOpenWorkspace(workspace: WorkspaceDef) {
    if (busy || !onOpenWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onOpenWorkspace(workspace);
      if (result !== false) onClose?.();
    } finally {
      setBusy(false);
    }
  }

  // Workspace-mode candidate folder list. Sources, in display order:
  //   1. `wsExtra` — paths the user just picked via "Add Folder"
  //      (surfaced at the top so the latest addition is visible)
  //   2. `recentProjects` — recently-opened folders (the same set
  //      that powers the browse-mode Recents section)
  //   3. `workspaceCandidatePaths` — any other folders the daemon
  //      knows about (e.g. all imported projects with a baseDir)
  //      so the picker isn't capped at the recent-N list.
  // Paths are deduped while preserving the first-seen order, then
  // narrowed by the filter input (matches both absolute path and
  // tildified display form).
  const wsCandidates = useMemo<WorkspaceFolderRef[]>(() => {
    const seen = new Set<string>();
    const out: WorkspaceFolderRef[] = [];
    function push(path: string) {
      const trimmed = path.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push({ path: trimmed, name: workspaceBasename(trimmed) });
    }
    for (const p of wsExtra) push(p);
    for (const r of recentProjects) push(r.path);
    if (workspaceCandidatePaths) {
      for (const p of workspaceCandidatePaths) push(p);
    }
    const q = wsFilter.trim().toLowerCase();
    if (!q) return out;
    return out.filter(
      (c) =>
        c.path.toLowerCase().includes(q) ||
        tildify(c.path, homeDir).toLowerCase().includes(q),
    );
  }, [wsExtra, recentProjects, workspaceCandidatePaths, wsFilter, homeDir]);

  function toggleWsSelection(path: string) {
    setWsSelected((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }

  async function handleWsAddFolder() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await openFolderDialog();
      if (!picked) {
        // Native dialog cancelled or unavailable on this platform.
        // In-app folder-browser fallback is out of scope here: the
        // workspace builder only needs absolute paths, and forcing
        // the user back through the daemon dialog avoids the trust-
        // boundary edge cases of the import-flavored picker.
        return;
      }
      setWsExtra((prev) => (prev.includes(picked) ? prev : [picked, ...prev]));
      setWsSelected((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
    } finally {
      setBusy(false);
    }
  }

  async function handleWsCreate() {
    if (busy || wsSelected.length < 2 || !onOpenWorkspace) return;
    // Require an explicit workspace name. `saveWorkspace()` will fall
    // back to the primary folder's basename when given an empty string,
    // but that produces a workspace named identically to a plain folder
    // — visually indistinguishable from a regular recent row and the
    // exact failure mode the user reported ("只出现了 test1, 没有聚合").
    const trimmedName = wsName.trim();
    if (!trimmedName) {
      setError('Workspace needs a name.');
      return;
    }
    const folders: WorkspaceFolderRef[] = wsSelected.map((p) => ({
      path: p,
      name: workspaceBasename(p),
    }));
    const def = saveWorkspace({ name: trimmedName, folders });
    if (!def) {
      setError('Could not save workspace.');
      return;
    }
    onWorkspacesChanged?.();
    setBusy(true);
    try {
      const result = await onOpenWorkspace(def);
      if (result !== false) onClose?.();
    } finally {
      setBusy(false);
    }
  }

  async function handlePickFolder() {
    if (busy) return;
    // Preferred: Electron's atomic pickAndImport bridge (PR #974 trust
    // boundary). One call → native dialog + HMAC-gated import in one shot.
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
    // Browser fallback: ask the daemon to open the native OS folder
    // dialog (osascript on macOS, zenity on Linux, PowerShell on
    // Windows) so the user still sees a real system picker instead of
    // an in-app folder tree. The returned absolute path is fed back
    // through `onImportFolder` to open the project.
    setBusy(true);
    setError(null);
    try {
      const picked = await openFolderDialog();
      if (!picked) {
        // Native dialog unavailable or user cancelled. Only escalate
        // to the in-app folder browser when the OS-level dialog is
        // genuinely not supported on this platform (no `osascript`
        // / `zenity` / PowerShell). If the user simply cancelled,
        // the in-app dialog opening would feel like a UI bug.
        return;
      }
      const ok = await onImportFolder(picked);
      if (ok !== false) onClose?.();
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'workspace') {
    const wsNameTrimmed = wsName.trim();
    // The hint reads as a progressive disclosure: first you need ≥2
    // folders, then a name, then we tell you how many are selected.
    // Mirrors the disabled-state logic on the Create button so the
    // user can't be left guessing why Create is greyed out.
    const hint =
      wsSelected.length < 2
        ? 'Select at least 2'
        : !wsNameTrimmed
          ? 'Name the workspace'
          : `${wsSelected.length} selected`;
    const canCreate = wsSelected.length >= 2 && wsNameTrimmed.length > 0;
    return (
      <div
        className="project-switcher-panel project-switcher-panel--workspace"
        data-testid="project-switcher-panel"
        data-mode="workspace"
      >
        <div className="project-switcher-panel__ws-head">
          <button
            type="button"
            className="project-switcher-panel__back"
            onClick={exitWorkspaceMode}
            disabled={busy}
            aria-label="Back to recent projects"
            title="Back"
            data-testid="workspace-back"
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <input
            type="text"
            className="project-switcher-panel__ws-name"
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="Workspace Name"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            data-testid="workspace-name"
            autoFocus
          />
        </div>

        <div className="project-switcher-panel__search">
          <input
            type="text"
            value={wsFilter}
            onChange={(e) => setWsFilter(e.target.value)}
            placeholder="Filter folders…"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            data-testid="workspace-filter"
          />
        </div>

        <div className="project-switcher-panel__list" data-testid="workspace-candidates">
          {wsCandidates.length === 0 ? (
            <div className="project-switcher-panel__empty">
              No folders match.
            </div>
          ) : (
            wsCandidates.map((c) => {
              const selected = wsSelected.includes(c.path);
              return (
                <button
                  key={c.path}
                  type="button"
                  className="project-switcher-row"
                  onClick={() => toggleWsSelection(c.path)}
                  disabled={busy}
                  title={c.path}
                  aria-pressed={selected}
                  data-testid="workspace-candidate-row"
                  data-selected={selected ? 'true' : undefined}
                >
                  <Icon name="folder" size={14} />
                  <span className="project-switcher-row__label">
                    {tildify(c.path, homeDir)}
                  </span>
                  {selected ? (
                    <Icon
                      name="check"
                      size={14}
                      className="project-switcher-row__check"
                    />
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {error ? (
          <div role="alert" className="project-switcher-panel__error">
            {error}
          </div>
        ) : null}

        <div className="project-switcher-panel__foot">
          <button
            type="button"
            className="project-switcher-row"
            onClick={handleWsAddFolder}
            disabled={busy}
            data-testid="workspace-add-folder"
          >
            <Icon name="plus" size={14} />
            <span className="project-switcher-row__label">
              {busy ? 'Picking…' : 'Add Folder'}
            </span>
          </button>
          <div className="project-switcher-panel__create-row">
            <button
              type="button"
              className="project-switcher-row project-switcher-row--cta"
              onClick={handleWsCreate}
              disabled={busy || !canCreate || !onOpenWorkspace}
              data-testid="workspace-create"
            >
              <Icon name="check" size={14} />
              <span className="project-switcher-row__label">Create</span>
            </button>
            <span className="project-switcher-panel__hint">{hint}</span>
          </div>
        </div>
      </div>
    );
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
        {filtered.map((entry) => {
          const ws = workspaceByPrimaryPath.get(entry.path);
          if (ws && onOpenWorkspace) {
            return (
              <WorkspaceRow
                key={`ws:${ws.id}`}
                workspace={ws}
                homeDir={homeDir}
                disabled={busy}
                onOpen={() => handleOpenWorkspace(ws)}
                {...(onDeleteWorkspace
                  ? { onDelete: () => onDeleteWorkspace(ws.id) }
                  : {})}
              />
            );
          }
          return (
            <SwitcherRow
              key={entry.path}
              label={tildify(entry.path, homeDir)}
              title={entry.path}
              onClick={() => handleOpenEntry(entry.path)}
              disabled={busy}
            />
          );
        })}
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
          label={busy ? 'Opening…' : 'Open Workspace'}
          onClick={handlePickFolder}
          testId="project-switcher-pick"
          disabled={busy || (!hasElectronPickAndImport && !onOpenPicker)}
        />
        {/* {onOpenWorkspace ? (
          <SwitcherRow
            label="Set Up Workspace…"
            icon="grid"
            onClick={enterWorkspaceMode}
            testId="project-switcher-setup-workspace"
            disabled={busy}
          />
        ) : null} */}
      </div>
    </div>
  );
}

// A workspace appears in the unified Recents list as a single row with
// the same folder icon as a plain recent entry — what differentiates
// it is the hover popover, which mirrors Cursor's UX: it pops to the
// right of the row, lists the workspace name as a header, and shows
// every constituent folder path tildified beneath it. The popover is
// CSS-only (`:hover` on the wrapper), so no extra state needed.
function WorkspaceRow({
  workspace,
  homeDir,
  onOpen,
  onDelete,
  disabled,
}: {
  workspace: WorkspaceDef;
  homeDir: string;
  onOpen: () => void;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="project-switcher-row project-switcher-row--workspace"
      data-testid="project-switcher-workspace-row"
    >
      <button
        type="button"
        className="project-switcher-row__main"
        onClick={onOpen}
        disabled={disabled}
      >
        <Icon name="folder" size={14} />
        <span className="project-switcher-row__label">{workspace.name}</span>
      </button>
      {onDelete ? (
        <button
          type="button"
          className="project-switcher-row__delete"
          onClick={onDelete}
          disabled={disabled}
          aria-label={`Remove workspace ${workspace.name}`}
          title="Remove workspace"
        >
          ×
        </button>
      ) : null}
      <div
        className="project-switcher-row__popover"
        role="tooltip"
        data-testid="project-switcher-workspace-popover"
      >
        <div className="project-switcher-row__popover-title">{workspace.name}</div>
        <ul className="project-switcher-row__popover-list">
          {workspace.folders.map((f) => (
            <li key={f.path}>{tildify(f.path, homeDir)}</li>
          ))}
        </ul>
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
  icon,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
  icon?: Parameters<typeof Icon>[0]['name'];
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
      <Icon name={icon ?? 'folder'} size={14} />
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
