// Project / conversation / message / tab persistence — backed by the
// daemon's SQLite store. All writes round-trip through HTTP so projects
// stay coherent across multiple browser tabs and across restarts.
//
// These helpers fail soft (returning null / [] on transport errors) so
// the UI can stay rendered when the daemon is briefly unreachable.

import type {
  ChatMessage,
  Conversation,
  OpenTabsState,
  Project,
  ProjectTemplate,
} from '../types';

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
 * (Phase 2, accepted 2026-05-10) this is the only way to start a new
 * project: the pre-RFC `POST /api/projects` (UUID-creating) and
 * `POST /api/import/claude-design` (UUID ZIP import) endpoints are gone.
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
 * `null` on transport failure so the dialog can render an inline error
 * row instead of crashing the whole tree. The daemon itself returns
 * `entries: []` + `error: { code, message }` for permission failures, so
 * a non-null result with `entries.length === 0` is meaningful too.
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

export async function listDir(p?: string, options?: { showHidden?: boolean }): Promise<FsLsResult | null> {
  try {
    const params = new URLSearchParams();
    if (p) params.set('path', p);
    if (options?.showHidden) params.set('showHidden', '1');
    const qs = params.toString();
    const resp = await fetch(`/api/fs/ls${qs ? `?${qs}` : ''}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<FsLsResult>;
    if (typeof json.path !== 'string') return null;
    return {
      path: json.path,
      parent: typeof json.parent === 'string' ? json.parent : null,
      home: typeof json.home === 'string' ? json.home : '',
      entries: Array.isArray(json.entries) ? json.entries : [],
      error: json.error,
    };
  } catch {
    return null;
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

export async function patchProject(
  id: string,
  patch: Partial<Project>,
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
