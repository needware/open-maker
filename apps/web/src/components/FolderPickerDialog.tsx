// Folder picker dialog — the click-to-pick fallback used by the project
// switcher when `window.electronAPI.pickFolder()` is unavailable (browser
// dev, headless e2e, Linux distros without a native dialog). Talks to the
// daemon's `GET /api/fs/ls` endpoint which lists subdirectories of any
// path on the daemon's host.
//
// UX shape:
//
//   ┌── Choose a folder ────────────────────────┐
//   │ [↑]  ~/worker/hostex-h5_v2                │  ← breadcrumb / up
//   │                                           │
//   │   📁 .git                                 │  ← optional (showHidden)
//   │   📁 docs                                 │
//   │   📁 src                                  │
//   │   …                                       │
//   │                                           │
//   │              [Cancel]  [Open this folder] │
//   └───────────────────────────────────────────┘
//
// Clicking a row navigates into that subdirectory. The "Open this folder"
// CTA opens the *current* folder (not a selected row), matching how
// macOS Finder's "Choose…" dialog works — once you're inside the folder
// you want, you confirm. This mirrors the existing Cursor / VS Code
// behavior for "Open Folder".
//
// Why a custom modal instead of `<input type="file" webkitdirectory>`?
// That HTML control returns a `FileList`, not the absolute path, and
// scoped browser sandboxes mean the daemon couldn't read those files
// later anyway. A daemon-mediated picker is the only path that gives us
// real OS paths, which is what the project-as-unit model demands.

import { useEffect, useMemo, useRef, useState } from 'react';
import { listDir, type FsLsEntry } from '../state/projects';
import { Icon } from './Icon';

interface Props {
  /** When `null` the dialog is closed and unmounted. */
  open: boolean;
  /** Initial directory to show. Most callers will pass the daemon-
   *  reported home dir from `RecentProjectsResult.homeDir`. Falls back
   *  to whatever the daemon resolves when omitted. */
  initialPath?: string;
  /** Resolved when the user clicks "Open this folder". The picker
   *  closes itself before invoking this callback. */
  onOpen: (path: string) => void;
  onClose: () => void;
}

export function FolderPickerDialog({ open, initialPath, onOpen, onClose }: Props) {
  const [cwd, setCwd] = useState<string>('');
  const [entries, setEntries] = useState<FsLsEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState<string>('');
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  async function navigate(target?: string) {
    setLoading(true);
    setError(null);
    const result = await listDir(target, { showHidden });
    setLoading(false);
    if (!result) {
      setError('Could not reach the daemon. Is it still running?');
      return;
    }
    setCwd(result.path);
    setParent(result.parent);
    setHome(result.home);
    setEntries(result.entries);
    if (result.error) {
      setError(`Cannot read folder: ${result.error.code}. Try a different one.`);
    }
  }

  // Initial load when the dialog opens. Resetting state on each open
  // avoids leaking the previous browse session into the next one (e.g.
  // a stale error after the user retries).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntries([]);
    setCwd('');
    setParent(null);
    void navigate(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  // Re-fetch when the user toggles `showHidden` to keep the listing
  // honest. Skipped when the dialog isn't open or no cwd is loaded yet.
  useEffect(() => {
    if (!open || !cwd) return;
    void navigate(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // Esc to close + focus trap-lite (focus the dialog so keyboard users
  // can tab into the entries immediately).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const breadcrumb = useMemo(() => tildify(cwd, home), [cwd, home]);

  if (!open) return null;

  function handleEnter(name: string) {
    if (!cwd) return;
    const next = joinPath(cwd, name);
    void navigate(next);
  }

  function handleUp() {
    if (parent) void navigate(parent);
  }

  function handleHome() {
    if (home) void navigate(home);
  }

  function handleConfirm() {
    if (!cwd) return;
    onClose();
    onOpen(cwd);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose a folder"
      data-testid="folder-picker-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={{
          width: 'min(560px, 100%)',
          maxHeight: 'min(80vh, 640px)',
          background: 'var(--surface, #fff)',
          border: '1px solid var(--border-soft)',
          borderRadius: 12,
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.28)',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '14px 16px 10px',
            borderBottom: '1px solid var(--border-soft)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>Choose a folder</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="folder-picker-close"
            style={iconBtnStyle}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-soft)',
            fontSize: 12,
          }}
        >
          <button
            type="button"
            onClick={handleUp}
            disabled={!parent}
            title="Go to parent directory"
            data-testid="folder-picker-up"
            style={{ ...iconBtnStyle, opacity: parent ? 1 : 0.4 }}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          <button
            type="button"
            onClick={handleHome}
            disabled={!home || cwd === home}
            title="Home"
            data-testid="folder-picker-home"
            style={{ ...iconBtnStyle, opacity: home && cwd !== home ? 1 : 0.4 }}
          >
            <Icon name="folder" size={14} />
          </button>
          <span
            data-testid="folder-picker-breadcrumb"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--text-soft, var(--text-faint))',
            }}
            title={cwd}
          >
            {loading && !cwd ? 'Loading…' : breadcrumb || '/'}
          </span>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--text-faint)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              data-testid="folder-picker-show-hidden"
            />
            <span>Hidden</span>
          </label>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '6px 8px',
          }}
        >
          {error ? (
            <div
              role="alert"
              data-testid="folder-picker-error"
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: '#b00020',
              }}
            >
              {error}
            </div>
          ) : null}

          {!loading && entries.length === 0 && !error ? (
            <div
              style={{
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--text-faint)',
              }}
            >
              This folder has no subdirectories. Click <strong>Open this folder</strong> below to use it.
            </div>
          ) : null}

          {entries.map((entry) => (
            <FolderRow key={entry.name} name={entry.name} onClick={() => handleEnter(entry.name)} />
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            padding: '10px 14px',
            borderTop: '1px solid var(--border-soft)',
            background: 'var(--surface-soft, transparent)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            data-testid="folder-picker-cancel"
            style={btnStyle}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!cwd || loading}
            data-testid="folder-picker-confirm"
            style={{
              ...btnStyle,
              fontWeight: 600,
              background: 'var(--accent, #2266ff)',
              color: '#fff',
              borderColor: 'transparent',
            }}
          >
            Open this folder
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderRow({ name, onClick }: { name: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-testid="folder-picker-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 10px',
        background: hover ? 'var(--surface-hover, rgba(0,0,0,0.04))' : 'transparent',
        border: 'none',
        borderRadius: 6,
        textAlign: 'left',
        cursor: 'pointer',
        color: 'inherit',
        fontSize: 13,
      }}
    >
      <Icon name="folder" size={14} />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    </button>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};

const btnStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  border: '1px solid var(--border-soft)',
  borderRadius: 6,
  background: 'var(--surface, transparent)',
  color: 'inherit',
  cursor: 'pointer',
};

/**
 * Mirror of `tildify` in EntryView.tsx — kept inline here to avoid a
 * circular dependency from EntryView importing this dialog importing
 * EntryView. Promote both copies to a shared `utils/path.ts` module
 * during the slice-3 refactor when more places need the helpers.
 */
function tildify(absPath: string, homeDir: string): string {
  if (!absPath) return absPath;
  if (!homeDir) return absPath;
  const home = homeDir.replace(/[\\/]+$/, '');
  if (!home) return absPath;
  if (absPath === home) return '~';
  if (absPath.startsWith(home + '/')) return '~/' + absPath.slice(home.length + 1);
  if (absPath.startsWith(home + '\\')) return '~\\' + absPath.slice(home.length + 1);
  return absPath;
}

/**
 * POSIX-style join that also handles Windows backslashes. Used to build
 * the next path when the user clicks a folder row. We do NOT call
 * `path` from `node:path` here because the web bundle would have to
 * polyfill it; a 4-line manual join is fine for our needs.
 */
function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  if (base.endsWith(sep)) return base + name;
  return base + sep + name;
}
