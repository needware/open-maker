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
import { listDir, type FsLsEntry, type FsLsOutcome } from '../state/projects';
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
  // Track the last attempted target so the Retry button knows what to
  // re-issue, and the error banner can show what we actually tried.
  // `null` means "daemon's home dir" (the no-arg call).
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function describeOutcomeError(outcome: Exclude<FsLsOutcome, { kind: 'ok' }>, target: string | null): string {
    const where = target ? ` (${target})` : '';
    if (outcome.kind === 'transport-error') {
      return `Could not reach the daemon. Is it still running?${where}`;
    }
    // http-error — daemon answered with a structured failure. Render
    // the actual code/message so the user can act on it instead of
    // being told the daemon is "still running" when it clearly is.
    if (outcome.code === 'FS_NOT_FOUND') {
      return `Folder not found${where}.`;
    }
    if (outcome.code === 'FS_NOT_DIR') {
      return `Not a folder${where}.`;
    }
    if (outcome.code) {
      return `${outcome.code}${where}: ${outcome.message}`;
    }
    return `Folder listing failed${where}: ${outcome.message}`;
  }

  async function navigate(target?: string) {
    const requested = target ?? null;
    setLoading(true);
    setError(null);
    setLastAttempt(requested);
    let outcome = await listDir(target, { showHidden });
    // Self-recovery: when the very first call fails because the
    // requested path no longer exists (e.g. `recentHomeDir` points at a
    // moved/deleted folder, or an unmounted external drive), fall back
    // to the daemon's home dir transparently. This rescues the picker
    // from getting stuck on a stale launch state — much better than
    // forcing the user to close + reopen the dialog.
    if (
      outcome.kind === 'http-error' &&
      outcome.code === 'FS_NOT_FOUND' &&
      requested !== null
    ) {
      outcome = await listDir(undefined, { showHidden });
    }
    setLoading(false);
    if (outcome.kind !== 'ok') {
      setError(describeOutcomeError(outcome, requested));
      return;
    }
    const { result } = outcome;
    setCwd(result.path);
    setParent(result.parent);
    setHome(result.home);
    setEntries(result.entries);
    if (result.error) {
      setError(`Cannot read folder: ${result.error.code}. Try a different one.`);
    }
  }

  function retryLastAttempt() {
    void navigate(lastAttempt ?? undefined);
  }

  function navigateToHome() {
    void navigate(undefined);
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
    setLastAttempt(null);
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
            {loading && !cwd
              ? 'Loading…'
              : breadcrumb || (cwd ? '/' : error ? '—' : 'Loading…')}
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
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '10px 12px',
                fontSize: 12,
                color: '#b00020',
              }}
            >
              <span>{error}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={retryLastAttempt}
                  disabled={loading}
                  data-testid="folder-picker-retry"
                  style={{ ...btnStyle, fontSize: 12, padding: '4px 10px' }}
                >
                  Retry
                </button>
                {lastAttempt !== null ? (
                  <button
                    type="button"
                    onClick={navigateToHome}
                    disabled={loading}
                    data-testid="folder-picker-go-home"
                    style={{ ...btnStyle, fontSize: 12, padding: '4px 10px' }}
                  >
                    Go to home
                  </button>
                ) : null}
              </div>
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
