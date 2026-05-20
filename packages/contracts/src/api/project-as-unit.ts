// Project-as-unit contract types.
//
// Background and rationale: see `docs/rfc-drafts/project-as-unit.md`.
//
// In the project-as-unit model, a project IS a directory on disk. There is
// no UUID-keyed shadow tree, no "create draft project" endpoint. Identity is
// the realpath of the directory. Each generation produces a *facet* (a
// subdirectory under `<project-root>/artifacts/<facet-id>/`) that shares the
// project's sources, brand (DESIGN.md), craft profile, and sibling facets.
//
// These types are used by the new endpoints in `architecture.md` §7:
//   POST   /api/projects/open
//   GET    /api/projects/recent
//   GET    /api/projects/:project/sources
//   POST   /api/projects/:project/facets
//   POST   /api/projects/:project/facets/:facet/regen
//   DELETE /api/projects/:project/facets/:facet
//
// Slice-1 note: this file is purely additive. The legacy `ProjectMetadata` /
// `Project` / `ImportFolderRequest` types in `./projects.ts` are still in
// effect for the current daemon and web. Slice 2 (daemon) and slice 4 (web)
// will retire them in lockstep with the implementation. Until then, both
// sets of types coexist in the package surface for consumer convenience.

// -----------------------------------------------------------------------------
// Project (= directory on disk)
// -----------------------------------------------------------------------------

/**
 * A reference to a project. The `path` is the canonicalized realpath of the
 * directory the user opened; it is the project's identity (invariant #1 in
 * the RFC: 1 project ↔ 1 directory).
 */
export interface ProjectRef {
  /** Absolute realpath of the project directory. */
  path: string;
  /** Display name. Defaults to the directory's basename; user-overridable
   *  via `project.json.name`. */
  name?: string;
  /** UNIX ms timestamp; set by the daemon when the project is opened. */
  lastOpenedAt?: number;
}

/**
 * `POST /api/projects/open` request body. The daemon canonicalizes `path`
 * via `realpath()`, refuses paths inside `RUNTIME_DATA_DIR`, and returns a
 * `ProjectRef`. Idempotent: opening the same realpath twice is a no-op.
 */
export interface OpenProjectRequest {
  /** Absolute or workspace-relative directory path. The daemon resolves
   *  symlinks before storage. */
  path: string;
  /** Optional display name; defaults to `basename(path)`. */
  name?: string;
  /** Optional skill/design-system pins applied to newly-created projects. */
  skillId?: string | null;
  designSystemId?: string | null;
  /**
   * Optional metadata patch. Cursor's "Set Up Workspace" sends
   * `{ workspaceName, workspaceRoots }` so a single project can represent
   * a multi-root workspace. The daemon merges this on top of the metadata
   * it produces on creation, and on idempotent re-open it only touches the
   * workspace-related fields if they're present in the patch (so opening
   * the same folder as a plain project later doesn't strip workspace info).
   */
  metadata?: Partial<import('./projects').ProjectMetadata>;
}

export interface OpenProjectResponse {
  project: ProjectRef;
}

/**
 * Entry in `~/.open-design/recent-projects.json`. Stale entries (path no
 * longer exists on disk) are dropped on daemon startup.
 */
export interface RecentProjectEntry {
  path: string;
  lastOpenedAt?: number;
}

export interface RecentProjectsResponse {
  /** Most recent first. */
  entries: RecentProjectEntry[];
  /**
   * Absolute path of the user's home directory, as `os.homedir()` reports
   * it on the daemon host. The web UI uses this to tildify paths in the
   * recents list ("/Users/me/proj" → "~/proj"), mirroring how Cursor's
   * project switcher renders entries. Returned by the daemon because the
   * web client can't otherwise know HOME without an extra preload IPC.
   */
  homeDir: string;
}

// -----------------------------------------------------------------------------
// Filesystem browser (powers the in-app folder picker)
// -----------------------------------------------------------------------------

/**
 * One entry returned by `GET /api/fs/ls`. Files are filtered out
 * server-side; only directories (real or symlinked) appear here.
 */
export interface FsLsEntry {
  /** Basename only — join with the response's `path` for the absolute. */
  name: string;
  /** Always `true` for entries the daemon returns; reserved so a future
   *  iteration can include files with `isDir: false` when the picker
   *  needs to show them (e.g. for a "select an image" dialog). */
  isDir: boolean;
}

export interface FsLsResponse {
  /** Realpath of the listed directory (symlinks resolved). */
  path: string;
  /** Parent directory; `null` at the filesystem root. */
  parent: string | null;
  /** `os.homedir()` on the daemon host — surfaced so the picker can
   *  expose a "Home" shortcut without a second request. */
  home: string;
  entries: FsLsEntry[];
  /** Set when the directory exists but the daemon couldn't read it
   *  (e.g. `EACCES`, `EPERM`). The picker should show the path with a
   *  "permission denied" hint instead of treating this as an empty
   *  directory or a 5xx. */
  error?: {
    code: string;
    message: string;
  };
}

// -----------------------------------------------------------------------------
// Sources (the project's content layer)
// -----------------------------------------------------------------------------

/**
 * Strategies for making a source dir available to the agent.
 *  - `mount`: symlink into the agent's CWD as `kb/<id>/`. No prompt cost.
 *  - `toc`: build a per-source ToC at compose time and inject it into the
 *           system prompt.
 *  - `both`: mount + toc (default).
 */
export type SourceStrategy = 'mount' | 'toc' | 'both';

/**
 * Default detection list for source directories at the project root, in
 * order. The first match becomes the active source unless `KNOWLEDGE.md`
 * declares an explicit `sources:` override.
 */
export const DEFAULT_SOURCE_DIR_NAMES = [
  'sources',
  'docs',
  'content',
  'knowledge',
  'wiki',
] as const;

export type DefaultSourceDirName = typeof DEFAULT_SOURCE_DIR_NAMES[number];

/**
 * A single source directory active for a project. `id` is unique within the
 * project; defaults to the directory's last segment, but can be overridden
 * by `KNOWLEDGE.md` `name:` for the project root, or by the user at attach
 * time.
 */
export interface SourceDirRef {
  /** Stable id, unique within the project. Constrained to `[a-z0-9-]+`. */
  id: string;
  /** Path relative to the project root (e.g. `docs`, `sources/brand`). */
  path: string;
  strategy: SourceStrategy;
  /** When `true`, runs against this source must not invent facts that are
   *  not present in the source. Multi-source ground is unioned across
   *  active sources at run time. */
  ground?: boolean;
  /** UI-level toggle. Disabled sources are not injected into compose. */
  enabled: boolean;
}

/**
 * Lightweight ToC entry produced by the source resolver. Each markdown file
 * in a source contributes one entry; long files keep only the front-matter
 * and first-level headings to stay within the source-index token budget.
 */
export interface SourceTocEntry {
  /** Path relative to the source dir's root. */
  relPath: string;
  /** Front-matter as a flat object (string values only — the daemon does
   *  not preserve nested types). */
  frontmatter?: Record<string, string>;
  /** First-level (`#`) headings, in document order. */
  headings: string[];
  /** UNIX ms; used for cache invalidation. */
  mtime: number;
}

export interface SourceToc {
  source: SourceDirRef;
  /** Bytes of all source markdown files indexed (for budget reporting). */
  totalBytes: number;
  /** Number of files indexed. */
  totalFiles: number;
  entries: SourceTocEntry[];
}

/**
 * `KNOWLEDGE.md` front-matter at the project root. All fields optional; an
 * absent `KNOWLEDGE.md` falls back to default source detection.
 */
export interface KnowledgeManifest {
  name?: string;
  domain?: string;
  voice?: string;
  /** Paths under the project root that should be treated as sources.
   *  Overrides default detection when present. */
  sources?: string[];
  /** Glob patterns relative to source roots; matching files are excluded
   *  from the ToC and from mount. */
  exclude?: string[];
  /** Source-relative paths that should win in budget contention. */
  priority?: string[];
}

/** `GET /api/projects/:project/sources` */
export interface ProjectSourcesResponse {
  sources: SourceDirRef[];
  /** Optional summary ToC; when omitted, the UI fetches per-source on
   *  demand. */
  tocs?: SourceToc[];
}

// -----------------------------------------------------------------------------
// Facets (each artifact = a facet of the project)
// -----------------------------------------------------------------------------

/**
 * Output mode. Decides artifact shape only (the project context — sources,
 * brand, craft — is implicit per `modes.md` §5).
 *
 * Aligned with `docs/modes.md` §1–§4 plus the Image / Video / Audio modes
 * that already exist as `prompt-templates/` and skill prefixes. The
 * Image/Video/Audio modes have a separate RFC for their preview pipelines;
 * this enum reserves the names so contracts don't change again later.
 */
export type FacetMode =
  | 'prototype'
  | 'deck'
  | 'template'
  | 'design-system'
  | 'image'
  | 'video'
  | 'audio';

/**
 * Lightweight reference to a facet, as it appears in lists / grids.
 */
export interface FacetRef {
  /** Constrained to `[a-z0-9-]+`; doubles as the directory name under
   *  `<project-root>/artifacts/<id>/`. */
  id: string;
  mode: FacetMode;
  /** Skill name (matches `SKILL.md` front-matter `name:`). */
  skill: string;
  /** UNIX ms; updated on every `regen`. */
  lastRunAt?: number;
}

/**
 * Full manifest, persisted to `<project-root>/artifacts/<id>/facet.json`.
 */
export interface FacetManifest extends FacetRef {
  /** Git SHA, tag, or `local` for a working-copy skill. */
  skillVersion?: string;
  /** Project-root-relative path of the active design system, or `null` if
   *  the project has no `DESIGN.md`. */
  designSystem?: string | null;
  /** Project-root-relative paths of source files the agent actually read
   *  (best-effort; populated from agent tool-call traces). */
  sourcesUsed?: string[];
  /** The user prompt that produced the most recent run. */
  lastBrief?: string;
  /** Skill-declared `od.parameters` values from the last run. */
  parameters?: Record<string, unknown>;
}

/** `POST /api/projects/:project/facets` */
export interface CreateFacetRequest {
  mode: FacetMode;
  skill: string;
  brief: string;
  /** Optional skill-declared parameters (`od.parameters` in the skill
   *  manifest). */
  parameters?: Record<string, unknown>;
  /** Optional facet id override; default is server-generated from the mode
   *  + skill + a short slug derived from the brief. */
  id?: string;
}

export interface CreateFacetResponse {
  facet: FacetManifest;
}

/** `POST /api/projects/:project/facets/:facet/regen` */
export interface RegenFacetRequest {
  /** New brief; when omitted, the previous `lastBrief` is reused. */
  brief?: string;
  parameters?: Record<string, unknown>;
  /** When `true`, the daemon preserves files inside the facet dir that the
   *  agent does not explicitly write to during this run. Default `false`
   *  (agent's writes are authoritative). */
  keepContent?: boolean;
}

export interface RegenFacetResponse {
  facet: FacetManifest;
}

/** `DELETE /api/projects/:project/facets/:facet` */
export interface DeleteFacetResponse {
  /** Where the deleted facet was moved (soft-delete to
   *  `<project-root>/.od/trash/<facet-id>/`). The daemon retains soft-
   *  deleted facets until cache GC. */
  trashedTo: string;
}

/**
 * `GET /api/projects/:project/facets` — flat list, ordered by `lastRunAt`
 * descending (most recently used first).
 */
export interface ProjectFacetsResponse {
  facets: FacetManifest[];
}

// -----------------------------------------------------------------------------
// Compose summary (informational; surfaced in run telemetry)
// -----------------------------------------------------------------------------

/**
 * Sibling-facet summary entry. The daemon builds a `SiblingFacetSummary[]`
 * at compose time and injects it between the sources index and the skill
 * body so a new facet stays consistent in voice / headlines with the
 * project's existing facets.
 */
export interface SiblingFacetSummary {
  id: string;
  mode: FacetMode;
  skill: string;
  lastBrief?: string;
}
