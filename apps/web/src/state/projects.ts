// Project / conversation / message / tab persistence — backed by the
// daemon's SQLite store. All writes round-trip through HTTP so projects
// stay coherent across multiple browser tabs and across restarts.
//
// These helpers fail soft (returning null / [] on transport errors) so
// the UI can stay rendered when the daemon is briefly unreachable.

import type {
  ApiError,
  AppliedPluginSnapshot,
  ApplyResult,
  CreatePluginShareProjectResponse,
  HandoffRequest,
  HandoffResponse,
  ImportFolderRequest,
  ImportFolderResponse,
  InstalledPluginRecord,
  PluginInstallOutcome,
  PluginShareAction,
  ProjectMetadata,
  ProjectPluginFolderInstallRequest,
} from '@open-design/contracts';
import { randomUUID } from '../utils/uuid';
import type {
  ChatMessage,
  Conversation,
  OpenTabsState,
  Project,
  ProjectTemplate,
} from '../types';

export type { PluginInstallOutcome } from '@open-design/contracts';
export type { PluginShareAction } from '@open-design/contracts';

export async function listProjects(): Promise<Project[]> {
  try {
    const resp = await fetch('/api/projects');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { projects: Project[] };
    return json.projects ?? [];
  } catch {
    return [];
  }
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    return json.project;
  } catch {
    return null;
  }
}

/**
 * Open (or re-open) a folder as a project. Per RFC `project-as-unit.md`
 * (Phase 2, accepted 2026-05-10) this is the preferred way to start a
 * new project against an on-disk folder. `createProject` /
 * `importFolderProject` remain available for legacy flows and for the
 * plugin loop entry that needs a UUID-allocated project.
 *
 * Idempotent — opening the same realpath twice returns the existing row
 * (no duplicate). The response carries `conversationId` / `entryFile`
 * only when a new project row was created; for already-known projects
 * the daemon returns `{ project }` only, so callers should treat both
 * as optional.
 */
export async function openProject(input: {
  path: string;
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  /**
   * Optional metadata patch. Currently the daemon only honors the
   * workspace-related fields (`workspaceName`, `workspaceRoots`) here so
   * that "Set Up Workspace" can stamp multi-root identity in the same
   * round-trip that creates / re-opens the workspace's project. Other
   * fields are ignored by the daemon.
   */
  metadata?: Partial<ProjectMetadata>;
}): Promise<
  | { project: Project; conversationId?: string; entryFile?: string | null }
  | null
> {
  try {
    const resp = await fetch('/api/projects/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as {
      project: Project;
      conversationId?: string;
      entryFile?: string | null;
    };
  } catch {
    return null;
  }
}

export async function createProject(input: {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  // Plan §3.A1 / spec §11.5 — POST /api/projects accepts a pluginId
  // (or pre-applied snapshot id) to resolve and pin a plugin to the new
  // project. Used by the PluginLoopHome flow on Home.
  pluginId?: string;
  appliedPluginSnapshotId?: string;
  pluginInputs?: Record<string, unknown>;
}): Promise<{ project: Project; conversationId: string; appliedPluginSnapshotId?: string } | null> {
  try {
    // `randomUUID` falls back to `crypto.getRandomValues` / `Math.random`
    // when `crypto.randomUUID` is unavailable. Open Maker served over
    // plain HTTP on a LAN IP (Docker / unRAID self-hosting) is a
    // non-secure context, where `crypto.randomUUID` is undefined and
    // calling it directly throws — the surrounding try/catch then turns
    // the Create button into a silent no-op (issue #849).
    const id = randomUUID();
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...input }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as {
      project: Project;
      conversationId: string;
      appliedPluginSnapshotId?: string;
    };
  } catch {
    return null;
  }
}

/**
 * Pre-RFC ZIP-import flow (Claude Design canvas archives). Kept around
 * because the daemon still serves /api/import/claude-design and the
 * EntryShell hero offers an "Import .zip" affordance. The daemon
 * stamps `importedFrom: 'claude-design'` on the project metadata
 * (extracted into a scratch baseDir per project-as-unit) so the
 * resulting project still satisfies the RFC invariant.
 */
export async function importClaudeDesignZip(
  file: File,
): Promise<{ project: Project; conversationId: string; entryFile: string } | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/import/claude-design', {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as {
      project: Project;
      conversationId: string;
      entryFile: string;
    };
  } catch {
    return null;
  }
}

export async function importFolderProject(
  input: ImportFolderRequest,
): Promise<ImportFolderResponse> {
  const resp = await fetch('/api/import/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    let message = 'Failed to import folder';
    try {
      const body = await resp.json();
      if (body?.error?.message) message = body.error.message;
    } catch { /* use default message */ }
    throw new Error(message);
  }
  return (await resp.json()) as ImportFolderResponse;
}

/**
 * `GET /api/projects/recent` — flat list of recently-opened folders, most
 * recent first. Stale entries (paths that no longer exist on disk) are
 * pruned by the daemon on read, so callers can render this list directly.
 *
 * The response also carries `homeDir` so the UI can tildify entries
 * ("/Users/me/proj" → "~/proj"), mirroring Cursor's project switcher.
 */
export interface RecentProjectEntry {
  path: string;
  lastOpenedAt?: number;
}

export interface RecentProjectsResult {
  entries: RecentProjectEntry[];
  /** Absolute path of the user's home dir, as the daemon sees it. Empty
   *  string when the daemon failed to report it. */
  homeDir: string;
}

export async function listRecentProjects(): Promise<RecentProjectsResult> {
  try {
    const resp = await fetch('/api/projects/recent');
    if (!resp.ok) return { entries: [], homeDir: '' };
    const json = (await resp.json()) as Partial<RecentProjectsResult>;
    return {
      entries: Array.isArray(json.entries) ? json.entries : [],
      homeDir: typeof json.homeDir === 'string' ? json.homeDir : '',
    };
  } catch {
    return { entries: [], homeDir: '' };
  }
}

/**
 * `GET /api/fs/ls` — list the immediate subdirectories of `path` so the
 * in-app folder picker can navigate the daemon's host filesystem. Used
 * as the click-to-pick fallback when `window.electronAPI.pickFolder` is
 * unavailable (browser dev / headless tests).
 *
 * Returns a discriminated outcome so the picker can tell apart three
 * very different failure modes — and stop accusing the daemon of being
 * down when it's actually answering with a structured FS error:
 *   - `transport-error` — fetch threw (CORS, daemon really down, network)
 *   - `http-error`      — daemon answered with a non-2xx (`FS_NOT_FOUND`,
 *                         `FS_NOT_DIR`, `INTERNAL_ERROR`); we surface the
 *                         daemon's own error code/message verbatim
 *   - `ok`              — daemon answered 2xx; the inner `result.error`
 *                         (e.g. `EACCES`) is a soft, navigable failure
 */
export interface FsLsEntry {
  name: string;
  isDir: boolean;
}

export interface FsLsResult {
  path: string;
  parent: string | null;
  home: string;
  entries: FsLsEntry[];
  error?: { code: string; message: string };
}

export type FsLsOutcome =
  | { kind: 'ok'; result: FsLsResult }
  | { kind: 'transport-error'; message: string }
  | { kind: 'http-error'; status: number; code?: string; message: string };

export async function listDir(
  p?: string,
  options?: { showHidden?: boolean },
): Promise<FsLsOutcome> {
  let resp: Response;
  try {
    const params = new URLSearchParams();
    if (p) params.set('path', p);
    if (options?.showHidden) params.set('showHidden', '1');
    const qs = params.toString();
    resp = await fetch(`/api/fs/ls${qs ? `?${qs}` : ''}`);
  } catch (err) {
    return { kind: 'transport-error', message: String(err) };
  }
  if (!resp.ok) {
    let code: string | undefined;
    let message = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the generic HTTP status message.
    }
    return { kind: 'http-error', status: resp.status, code, message };
  }
  let json: Partial<FsLsResult>;
  try {
    json = (await resp.json()) as Partial<FsLsResult>;
  } catch (err) {
    return {
      kind: 'http-error',
      status: resp.status,
      message: `malformed response: ${String(err)}`,
    };
  }
  if (typeof json.path !== 'string') {
    return {
      kind: 'http-error',
      status: resp.status,
      message: 'malformed response: missing "path" field',
    };
  }
  return {
    kind: 'ok',
    result: {
      path: json.path,
      parent: typeof json.parent === 'string' ? json.parent : null,
      home: typeof json.home === 'string' ? json.home : '',
      entries: Array.isArray(json.entries) ? json.entries : [],
      error: json.error,
    },
  };
}

/**
 * `GET /api/fs/walk-dirs` — recursively enumerate directories under a
 * root (defaults to the daemon-reported home). Powers the "Set Up
 * Workspace" inline picker so its candidate list shows every folder
 * the user has under `~/`, not just the recent-N projects.
 *
 * The daemon caps depth (default 4) and total results (default 1000)
 * and applies a noise filter (hidden dirs, `node_modules`, build/cache
 * folders, top-level system shells like `Library` / `AppData`). Fails
 * soft to `[]` so the UI degrades to the recents-only candidate set
 * when the daemon is unreachable.
 */
export interface WalkDirsResult {
  paths: string[];
  truncated: boolean;
}

export async function walkDirs(input?: {
  root?: string;
  maxDepth?: number;
  maxResults?: number;
}): Promise<WalkDirsResult> {
  try {
    const params = new URLSearchParams();
    if (input?.root) params.set('root', input.root);
    if (input?.maxDepth != null) params.set('maxDepth', String(input.maxDepth));
    if (input?.maxResults != null) params.set('maxResults', String(input.maxResults));
    const qs = params.toString();
    const resp = await fetch(`/api/fs/walk-dirs${qs ? `?${qs}` : ''}`);
    if (!resp.ok) return { paths: [], truncated: false };
    const json = (await resp.json()) as { paths?: unknown; truncated?: unknown };
    const paths = Array.isArray(json.paths)
      ? (json.paths.filter((p) => typeof p === 'string') as string[])
      : [];
    const truncated = json.truncated === true;
    return { paths, truncated };
  } catch {
    return { paths: [], truncated: false };
  }
}

// ---------- templates ----------

export async function listTemplates(): Promise<ProjectTemplate[]> {
  try {
    const resp = await fetch('/api/templates');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { templates: ProjectTemplate[] };
    return json.templates ?? [];
  } catch {
    return [];
  }
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function saveTemplate(input: {
  name: string;
  description?: string;
  sourceProjectId: string;
}): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

type ProjectPatch = Omit<Partial<Project>, 'pendingPrompt' | 'customInstructions'> & {
  pendingPrompt?: Project['pendingPrompt'] | null;
  customInstructions?: string | null;
};

export async function patchProject(
  id: string,
  patch: ProjectPatch,
): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    return json.project;
  } catch {
    return null;
  }
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- conversations ----------

export async function listConversations(
  projectId: string,
): Promise<Conversation[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { conversations: Conversation[] };
    return json.conversations ?? [];
  } catch {
    return [];
  }
}

export async function createConversation(
  projectId: string,
  title?: string,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { conversation: Conversation };
    return json.conversation;
  } catch {
    return null;
  }
}

// Outcome of a handoff synthesis call. The daemon route classifies its
// failures (RATE_LIMITED, EMPTY_TRANSCRIPT, an upstream 400 with provider
// detail, ...); `{ error }` carries that structured error through so the
// caller can show the real reason instead of a generic message. `null`
// is reserved for a transport failure or an unparseable error body.
export type HandoffOutcome = HandoffResponse | { error: ApiError } | null;

// Synthesizes a self-contained "first user message" from the project's
// chat transcript so a fresh conversation can resume work without the
// user replaying context by hand. A transport failure returns null; a
// daemon-classified failure returns `{ error }` so the caller keeps the
// daemon's message/details rather than collapsing every case into one
// generic toast.
export async function synthesizeHandoff(
  projectId: string,
  body: HandoffRequest,
): Promise<HandoffOutcome> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/handoff`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: ApiError }
        | null;
      return payload?.error ? { error: payload.error } : null;
    }
    return (await resp.json()) as HandoffResponse;
  } catch {
    return null;
  }
}

export async function patchConversation(
  projectId: string,
  conversationId: string,
  patch: Partial<Conversation>,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { conversation: Conversation };
    return json.conversation;
  } catch {
    return null;
  }
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- messages ----------

export async function listMessages(
  projectId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { messages: ChatMessage[] };
    return json.messages ?? [];
  } catch {
    return [];
  }
}

export interface SaveMessageOptions {
  telemetryFinalized?: boolean;
}

export async function saveMessage(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
): Promise<void> {
  try {
    const body = options.telemetryFinalized
      ? { ...message, telemetryFinalized: true }
      : message;
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  } catch {
    // best-effort persistence — UI keeps the message in-memory either way
  }
}

// ---------- tabs ----------

export async function loadTabs(projectId: string): Promise<OpenTabsState> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/tabs`,
    );
    if (!resp.ok) return { tabs: [], active: null };
    return (await resp.json()) as OpenTabsState;
  } catch {
    return { tabs: [], active: null };
  }
}

export async function saveTabs(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  try {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch {
    // best-effort
  }
}

// ---------- plugins ----------
// Plan §3.C1 — plugin discovery + apply.
//
// applyPlugin() is the canonical entry point for both the inline rail
// (NewProjectPanel + ChatComposer) and the marketplace detail page. It
// hits POST /api/plugins/:id/apply, which is the same pure resolver
// the daemon uses; the response carries everything the composer needs:
//   - query (pre-filled brief)
//   - contextItems (chip strip)
//   - inputs (form fields)
//   - appliedPlugin (snapshot id; sent back on POST /api/runs to pin
//     the prompt block to the frozen view)

export interface ListPluginsOptions {
  includeHidden?: boolean;
}

export async function listPlugins(
  options: ListPluginsOptions = {},
): Promise<InstalledPluginRecord[]> {
  try {
    const resp = await fetch('/api/plugins');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { plugins?: InstalledPluginRecord[] };
    const plugins = json.plugins ?? [];
    return options.includeHidden ? plugins : plugins.filter(isVisiblePlugin);
  } catch {
    return [];
  }
}

export function isVisiblePlugin(plugin: InstalledPluginRecord): boolean {
  const od = (plugin.manifest?.od ?? {}) as Record<string, unknown>;
  return od.hidden !== true;
}

interface PluginInstallEvent {
  kind?: 'progress' | 'success' | 'error';
  phase?: string;
  message?: string;
  plugin?: InstalledPluginRecord;
  warnings?: string[];
}

export async function installPluginSource(source: string): Promise<PluginInstallOutcome> {
  const log: string[] = [];
  try {
    const resp = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!resp.ok) {
      const message = await readErrorMessage(resp);
      return { ok: false, warnings: [], message, log };
    }
    if (!resp.body) {
      return {
        ok: false,
        warnings: [],
        message: 'Install stream did not start.',
        log,
      };
    }

    let success: InstalledPluginRecord | undefined;
    let warnings: string[] = [];
    let errorMessage: string | undefined;
    for await (const ev of readServerSentEvents(resp.body)) {
      if (ev.message) log.push(ev.message);
      if (ev.warnings) warnings = ev.warnings;
      if (ev.kind === 'success') success = ev.plugin;
      if (ev.kind === 'error') errorMessage = ev.message ?? 'Install failed.';
    }
    return {
      ok: Boolean(success) && !errorMessage,
      plugin: success,
      warnings,
      message: errorMessage ?? (success ? `Installed ${success.title}.` : 'Install finished.'),
      log,
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log,
    };
  }
}

export async function uploadPluginZip(file: File): Promise<PluginInstallOutcome> {
  const form = new FormData();
  form.append('file', file);
  return postPluginUpload('/api/plugins/upload-zip', form);
}

export async function uploadPluginFolder(files: File[]): Promise<PluginInstallOutcome> {
  const form = new FormData();
  for (const file of files) {
    const relativePath = getUploadRelativePath(file);
    form.append('files', file, file.name);
    form.append('paths', relativePath);
  }
  return postPluginUpload('/api/plugins/upload-folder', form);
}

export async function installGeneratedPluginFolder(
  projectId: string,
  relativePath: string,
): Promise<PluginInstallOutcome> {
  try {
    const request: ProjectPluginFolderInstallRequest = { path: relativePath };
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/plugins/install-folder`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const outcome = await readPluginInstallOutcome(resp);
    if (outcome.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('open-design:plugins-changed'));
    }
    return outcome;
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log: [],
    };
  }
}

export interface PluginShareOutcome {
  ok: boolean;
  message: string;
  url?: string;
  log?: string[];
  code?: string;
}

export async function publishGeneratedPluginToGitHub(
  projectId: string,
  relativePath: string,
): Promise<PluginShareOutcome> {
  return postGeneratedPluginShareAction(projectId, relativePath, 'publish-github');
}

export async function contributeGeneratedPluginToOpenDesign(
  projectId: string,
  relativePath: string,
): Promise<PluginShareOutcome> {
  return postGeneratedPluginShareAction(projectId, relativePath, 'contribute-open-design');
}

export type PluginShareProjectOutcome =
  | (CreatePluginShareProjectResponse & { ok: true })
  | {
      ok: false;
      message: string;
      code?: string;
    };

export async function createPluginShareProject(
  pluginId: string,
  action: PluginShareAction,
  locale?: string,
): Promise<PluginShareProjectOutcome> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/share-project`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(locale ? { locale } : {}),
        }),
      },
    );
    const body = (await resp.json().catch(() => null)) as
      | (Partial<CreatePluginShareProjectResponse> & {
          error?: string | { code?: string; message?: string };
          code?: string;
        })
      | null;
    if (resp.ok && body?.ok && body.project && body.conversationId) {
      return body as CreatePluginShareProjectResponse & { ok: true };
    }
    const errorMessage =
      typeof body?.error === 'string' ? body.error : body?.error?.message;
    const fallbackMessage = resp.statusText || 'Could not create plugin share project.';
    const message = body?.message ?? errorMessage ?? fallbackMessage;
    const code =
      body?.code ?? (typeof body?.error === 'object' ? body.error.code : undefined);
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
    };
  }
}

async function postGeneratedPluginShareAction(
  projectId: string,
  relativePath: string,
  action: 'publish-github' | 'contribute-open-design',
): Promise<PluginShareOutcome> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/plugins/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: relativePath }),
      },
    );
    const body = (await resp.json().catch(() => null)) as Partial<PluginShareOutcome> | null;
    return {
      ok: Boolean(resp.ok && body?.ok),
      message: body?.message ?? (resp.ok ? 'Action finished.' : 'Plugin share action failed.'),
      ...(body?.url ? { url: body.url } : {}),
      ...(body?.log ? { log: body.log } : {}),
      ...(body?.code ? { code: body.code } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
      log: [],
    };
  }
}

export async function upgradePlugin(id: string): Promise<PluginInstallOutcome> {
  const log: string[] = [];
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(id)}/upgrade`, {
      method: 'POST',
    });
    if (!resp.ok) {
      const message = await readErrorMessage(resp);
      return { ok: false, warnings: [], message, log };
    }
    if (!resp.body) {
      return {
        ok: false,
        warnings: [],
        message: 'Upgrade stream did not start.',
        log,
      };
    }
    let success: InstalledPluginRecord | undefined;
    let warnings: string[] = [];
    let errorMessage: string | undefined;
    for await (const ev of readServerSentEvents(resp.body)) {
      if (ev.message) log.push(ev.message);
      if (ev.warnings) warnings = ev.warnings;
      if (ev.kind === 'success') success = ev.plugin;
      if (ev.kind === 'error') errorMessage = ev.message ?? 'Upgrade failed.';
    }
    return {
      ok: Boolean(success) && !errorMessage,
      plugin: success,
      warnings,
      message: errorMessage ?? (success ? `Upgraded ${success.title}.` : 'Upgrade finished.'),
      log,
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log,
    };
  }
}

async function postPluginUpload(url: string, form: FormData): Promise<PluginInstallOutcome> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: form,
    });
    const json = (await resp.json()) as Partial<PluginInstallOutcome> & {
      error?: string | { message?: string };
    };
    if (resp.ok && json.ok) {
      return {
        ok: true,
        plugin: json.plugin,
        warnings: json.warnings ?? [],
        message: json.message ?? 'Plugin installed.',
        log: json.log ?? [],
      };
    }
    const message =
      json.message ??
      (typeof json.error === 'string' ? json.error : json.error?.message) ??
      resp.statusText;
    return {
      ok: false,
      warnings: json.warnings ?? [],
      message,
      log: json.log ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log: [],
    };
  }
}

async function readPluginInstallOutcome(resp: Response): Promise<PluginInstallOutcome> {
  const json = (await resp.json()) as Partial<PluginInstallOutcome> & {
    error?: string | { message?: string };
  };
  if (resp.ok && json.ok) {
    return {
      ok: true,
      ...(json.plugin ? { plugin: json.plugin } : {}),
      warnings: json.warnings ?? [],
      message: json.message ?? 'Plugin installed.',
      log: json.log ?? [],
    };
  }
  const message =
    json.message ??
    (typeof json.error === 'string' ? json.error : json.error?.message) ??
    resp.statusText;
  return {
    ok: false,
    ...(json.plugin ? { plugin: json.plugin } : {}),
    warnings: json.warnings ?? [],
    message,
    log: json.log ?? [],
  };
}

function getUploadRelativePath(file: File): string {
  const withRelativePath = file as File & { webkitRelativePath?: string };
  return withRelativePath.webkitRelativePath || file.name;
}

export async function uninstallPlugin(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface PluginMarketplace {
  id: string;
  url: string;
  trust: PluginMarketplaceTrust;
  specVersion?: string;
  version?: string;
  addedAt?: number;
  refreshedAt?: number;
  manifest: {
    name?: string;
    version?: string;
    plugins?: PluginMarketplaceEntry[];
  };
}

export type PluginMarketplaceTrust = 'official' | 'trusted' | 'restricted';

export interface PluginMarketplaceEntry {
  name: string;
  source: string;
  version?: string;
  ref?: string;
  dist?: {
    type?: string;
    archive?: string;
    integrity?: string;
    manifestDigest?: string;
  };
  versions?: Array<{
    version: string;
    source?: string;
    ref?: string;
    dist?: {
      type?: string;
      archive?: string;
      integrity?: string;
      manifestDigest?: string;
    };
    integrity?: string;
    manifestDigest?: string;
    deprecated?: boolean | string;
    yanked?: boolean;
    yankedAt?: string;
    yankReason?: string;
  }>;
  distTags?: Record<string, string>;
  integrity?: string;
  manifestDigest?: string;
  publisher?: {
    id?: string;
    github?: string;
    url?: string;
  };
  homepage?: string;
  license?: string;
  permissions?: string[];
  capabilitiesSummary?: string[];
  deprecated?: boolean | string;
  yanked?: boolean;
  yankedAt?: string;
  yankReason?: string;
  tags?: string[];
  title?: string;
  description?: string;
  icon?: string;
}

export interface PluginMarketplaceMutationOutcome {
  ok: boolean;
  marketplace?: PluginMarketplace;
  message: string;
}

export async function listPluginMarketplaces(): Promise<PluginMarketplace[]> {
  try {
    const resp = await fetch('/api/marketplaces');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { marketplaces?: PluginMarketplace[] };
    return json.marketplaces ?? [];
  } catch {
    return [];
  }
}

export async function addPluginMarketplace(input: {
  url: string;
  trust: PluginMarketplaceTrust;
}): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch('/api/marketplaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace source added.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function refreshPluginMarketplace(
  id: string,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace source refreshed.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function removePluginMarketplace(
  id: string,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      return { ok: false, message: await readErrorMessage(resp) };
    }
    return { ok: true, message: 'Marketplace source removed.' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function setPluginMarketplaceTrust(
  id: string,
  trust: PluginMarketplaceTrust,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trust }),
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace trust updated.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function readPluginMarketplaceOutcome(
  resp: Response,
  successMessage: string,
): Promise<PluginMarketplaceMutationOutcome> {
  if (!resp.ok) {
    return { ok: false, message: await readErrorMessage(resp) };
  }
  const marketplace = (await resp.json().catch(() => null)) as PluginMarketplace | null;
  return {
    ok: true,
    ...(marketplace ? { marketplace } : {}),
    message: successMessage,
  };
}

export async function applyPlugin(
  pluginId: string,
  options: {
    inputs?: Record<string, unknown>;
    projectId?: string;
    grantCaps?: string[];
    locale?: string;
  } = {},
): Promise<ApplyResult | null> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: options.inputs ?? {},
          projectId: options.projectId,
          grantCaps: options.grantCaps ?? [],
          locale: options.locale,
        }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as ApplyResult & { ok?: boolean };
    return json;
  } catch {
    return null;
  }
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const json = (await resp.json()) as {
      error?: string | { message?: string; data?: { errors?: unknown } };
      errors?: unknown;
      message?: string;
    };
    const message =
      json.message ??
      (typeof json.error === 'string' ? json.error : json.error?.message);
    const details = extractErrorDetails(
      typeof json.error === 'object' ? json.error.data?.errors : undefined,
      json.errors,
    );
    if (message && details.length > 0) return `${message}: ${details.join('; ')}`;
    if (message) return message;
  } catch {
    // Fall through to the status text below.
  }
  return resp.statusText || `HTTP ${resp.status}`;
}

function extractErrorDetails(...values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (item && typeof item === 'object' && 'message' in item) {
        const message = (item as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return [message.trim()];
      }
      return [];
    });
  });
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<PluginInstallEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const event = parseServerSentEvent(part);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const event = parseServerSentEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseServerSentEvent(raw: string): PluginInstallEvent | null {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as PluginInstallEvent;
  } catch {
    return null;
  }
}

// Fetch the immutable snapshot pinned to a project / conversation.
// Used by ProjectView to surface the active plugin as a context chip
// on user messages instead of re-rendering the inline plugin rail
// (the user already picked a plugin on Home — re-prompting is noise).
export async function fetchAppliedPluginSnapshot(
  snapshotId: string,
): Promise<AppliedPluginSnapshot | null> {
  try {
    const resp = await fetch(
      `/api/applied-plugins/${encodeURIComponent(snapshotId)}`,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as AppliedPluginSnapshot;
  } catch {
    return null;
  }
}

// Render the brief that the composer should display for the active
// applied plugin. Substitutes `{{var}}` placeholders inside
// useCase.query against the user-supplied inputs map; missing values
// stay as `{{var}}` so the gating "fill required" hint stays visible.
export function renderPluginBriefTemplate(
  template: string,
  inputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (full, key) => {
    if (key in inputs) {
      const v = inputs[key];
      if (v === undefined || v === null || v === '') return full;
      return String(v);
    }
    return full;
  });
}

export function resolvePluginQueryFallback(
  value: unknown,
  locale?: string,
  fallbackLocale: string = 'en',
): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (!isStringMap(value)) return '';

  const candidates = [
    locale,
    locale?.split('-')[0],
    fallbackLocale,
    fallbackLocale.split('-')[0],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = value[candidate];
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  }

  return Object.values(value).find((entry) => entry.length > 0) ?? '';
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}
