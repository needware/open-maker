# RFC: Project as the unit of creation

**Status:** Accepted (2026-05-10)
**Author:** @TBD
**Related:** `docs/spec.md` §3 · `docs/architecture.md` §3.6 / §7 · `docs/modes.md` · `docs/skills-protocol.md` §2 §5 · `docs/rfc-drafts/dev-server-auto-detect.md`

## Summary

Today OD treats the **artifact** as the unit of creation: a chat turn picks a mode, picks a skill, runs the agent, drops a file, and that file is the deliverable. The "project" exists, but mostly as a UUID-keyed scratch folder under `.od/projects/<uuid>/` that holds chat history and a flat list of artifacts.

This RFC proposes promoting the **project** to be the unit of creation, and pinning a project to a single physical directory on the user's disk:

> **A project is a directory on disk. Creation is bounded by, and operates inside, exactly one project at a time.**

Every artifact OD generates — prototype, deck, template fill, image, video script, audio — becomes a *facet* of that project, sharing the same content (`sources/`), the same brand (`DESIGN.md`), and the same craft profile. Folder import, today's optional path, becomes the only path.

This collapses several previously-discussed pieces (Knowledge Base as input axis, multi-KB attach, docs-driven mode) into one structural change: the project's own directory **is** the knowledge base.

OD is currently in spec finalization (roadmap Phase 0). There are no production users on the UUID-keyed project model that need to be migrated; this RFC supersedes that model outright. Implementation removes the UUID code paths rather than coexisting with them.

## Background

The artifact-centric model sketched in earlier spec drafts has three frictions that show up the moment users want OD to do more than one-shot HTML generation:

1. **No shared content layer.** Generating a prototype and a deck "about the same thing" requires retyping the brief twice; the agent has no way to keep the two consistent.
2. **No first-class user folder.** `.od/projects/<uuid>/` is a daemon-managed shadow tree; users can't `git add` it cleanly, can't browse it in Finder without translating a UUID, and can't move it without breaking session links.
3. **Two project shapes.** PR #597 added folder-import as an *alternative* to the UUID model. Two shapes mean every feature decision has to ask "which kind of project?".

The fix is to commit to one project shape — `project = a folder` — and make creation explicitly project-scoped. The UUID model is dropped entirely.

## Core definition

> **A project is a directory on disk. Creation is bounded by, and operates inside, exactly one project at a time.** All context (sources, design system, craft, sibling facets, history) is resolved from that directory; daemon global state never leaks into project creation.

### Invariants

These are non-negotiable. Any design or implementation work that breaks one of them is wrong.

| # | Invariant | Concrete consequence |
|---|---|---|
| 1 | **1 project ↔ 1 directory** (bijection) | Daemon does not own "project rows" decoupled from disk; two project records cannot share a `realpath`. |
| 2 | **Creation is project-scoped** | Every generative endpoint (`POST /api/chat`, `POST /api/projects/:project/facets`, …) takes a `projectPath` (or `:project` route segment that resolves to one) and refuses to run without it. |
| 3 | **Project context = directory contents** | `sources/`, `DESIGN.md`, `KNOWLEDGE.md`, `craft/` (project-local override), `artifacts/` are all read from the project root. Daemon-global state must not be appended to compose context. |
| 4 | **Projects do not see each other** | No cross-project sources, no shared KB, no shared facets. `~/.open-maker/recent-projects.json` is a UI list only — not a context source. |
| 5 | **The project directory is user-owned** | Daemon does not hide files, does not enforce a layout, does not block rename/move. If the user moves the folder, OD reports "not found" on next open and waits for the user to repoint. |
| 6 | **Outputs stay inside the project** | Facet artifacts write to `<project-root>/artifacts/<facet-id>/`. Writing outside the project root (to `/tmp/`, `~/.open-maker/`, another project) is a bug. |

## Project layout

```
<project-root>/                  ← the project IS this directory
├── project.json                 # optional manifest (name, intent, source list overrides)
├── DESIGN.md                    # optional brand, picked up automatically
├── KNOWLEDGE.md                 # optional project-intent doc + explicit sources index
├── sources/                     # optional content layer; default-detected if absent
│   ├── docs/
│   ├── brand/
│   └── refs/
├── craft/                       # optional project-local craft overrides; merges with repo craft
├── artifacts/                   # facets (one subdir per facet)
│   ├── prototype-landing/
│   │   ├── facet.json
│   │   ├── index.html
│   │   ├── assets/
│   │   └── history.jsonl
│   ├── deck-investor/
│   └── image-social-card/
└── .od/                         # daemon-local, gitignored
    ├── sessions/
    ├── cache/
    │   └── sources/<dir>/toc.json
    └── history.jsonl            # project-level (cross-facet) history
```

**Everything outside the project root is optional**, including the project root's own `project.json`. A bare empty directory is a valid project; OD's UI degrades gracefully (no source panel, no facet grid, just the chat).

## Default source detection

OD does not require a `KNOWLEDGE.md`. On project open, the daemon scans the project root for directories matching this name list (in order):

```
["sources", "docs", "content", "knowledge", "wiki"]
```

The first match becomes the default source root. If a `KNOWLEDGE.md` exists at the project root, its frontmatter `sources:` field overrides the default scan.

```yaml
# KNOWLEDGE.md (optional)
---
name: open-maker
domain: developer-tools
voice: technical, concise, no-marketing-fluff
sources:
  - docs/
  - blog/
exclude:
  - "docs/plans/**"
  - "docs/rfc-drafts/**"
priority:
  - docs/spec.md
  - docs/architecture.md
---

# Open Maker

(Free-form body — read by the agent as project intent.)
```

For the open-maker repository itself, no `KNOWLEDGE.md` is required: the existing `docs/` directory is auto-detected as the source root, making this repo a working example project on first open.

## Inputs to creation (the four axes, restated)

Inputs to a creation event, after this RFC, are:

| Axis | Lives at | Decides |
|---|---|---|
| **Brief** | user input at run time | the immediate request |
| **Skill** | `~/.claude/skills/`, `./skills/`, `./.claude/skills/` (existing precedence) | artifact shape |
| **Brand** | `<project-root>/DESIGN.md` | visual style |
| **Craft** | repo `craft/` + optional `<project-root>/craft/` overrides | universal craft rules |
| **Sources** ← *new axis introduced by this RFC* | `<project-root>/sources/` (or detected dir, or `KNOWLEDGE.md`-listed dirs) | content / facts / subject matter |

The "Knowledge Base" concept from earlier discussion **collapses into the Sources axis**. Multiple parallel KBs survive as multiple subdirectories under `sources/` (or multiple entries in `KNOWLEDGE.md.sources`).

## Compose pipeline

The system prompt assembled per generation is:

```
[craft]                       universal craft rules (selected by skill's od.craft.requires)
[DESIGN.md]                   project brand (sectioned per skill's od.design_system.sections)
[project intent]              KNOWLEDGE.md frontmatter (name/domain/voice) + body
[sources index]               ToC of active sources (multiple subdirs as separate sections)
[sibling facets summary]      list of existing facets in this project (id, mode, lastBrief)
[skill body]                  the skill's SKILL.md instructions
[brief]                       the user's prompt
```

Conflict precedence (highest wins): `brief > skill > sources > brand (DESIGN.md) > craft`.

**Sibling facets summary** is the new ingredient. When generating `artifacts/deck-investor/`, the agent receives a one-line summary of `artifacts/prototype-landing/` (mode, skill, last brief) and is instructed to keep voice/headlines consistent. This is "soft consistency" only; v2 will introduce `project-level atoms` (shared headline / one-liner / audience) that enforce hard consistency.

### Token budget

The combined `[sources index]` + `[sibling facets summary]` block is capped (default ~2k tokens). Over budget triggers two-step degradation:

1. Per-source-dir fair split.
2. Within an over-budget source, keep `priority`-listed files + first-level headings only; drop the rest to a path list.

Facets are mounted under the agent's CWD as a sibling tree, not pushed into the prompt:

```
<agent-cwd> = <project-root>/                ← agent's cwd is the project root
  sources/                                   ← read-only by convention
  artifacts/                                 ← writable
  ...
```

The agent reads sources via its own `Read` tool. Token cost stays bounded; depth of exploration is the agent's responsibility.

## Facets

A **facet** is one artifact subdirectory under `artifacts/`. Each facet is independently regenerable.

```
artifacts/prototype-landing/
├── facet.json
├── index.html
├── assets/
└── history.jsonl
```

`facet.json` schema:

```json
{
  "id": "prototype-landing",
  "mode": "prototype",
  "skill": "saas-landing",
  "skillVersion": "git-sha-or-tag",
  "designSystem": "DESIGN.md",
  "sourcesUsed": ["sources/docs/spec.md", "sources/docs/architecture.md"],
  "lastBrief": "SaaS landing for Open Maker; hero highlights skills protocol.",
  "lastRunAt": "2026-05-10T11:00:00Z",
  "parameters": { "hero_density": 96 }
}
```

### Facet lifecycle commands

| Command | Effect |
|---|---|
| `od project facet add <mode> [--skill <name>] [--id <facet-id>]` | Materialize a new facet subdir; run the skill once |
| `od project facet regen <facet-id> [--brief "..."] [--keep-content]` | Re-run; appends to facet's `history.jsonl`. `--keep-content` preserves existing files agent didn't touch |
| `od project facet remove <facet-id>` | Delete the facet subdir (asks for confirmation; soft-delete to `.od/trash/<facet-id>/`) |
| `od project facet rename <old> <new>` | Rename the subdir; rewrite `facet.id` in manifest |

UI mirrors these as buttons on the project page. The artifact grid shows one card per facet with thumbnail + mode badge + last-run timestamp.

## Skill protocol additions

Skills opt into project sources via a new optional `od.sources` block. The earlier-discussed `od.knowledge` name is dropped — the project's own sources directory is now authoritative, and there is no separate "knowledge" concept at the skill-author surface.

```yaml
od:
  sources:
    requires: true                # this skill needs at least one active source dir
    dirs: ["docs/"]               # default "*" = all detected sources; can scope
    require_all: false            # if dirs lists multiple, must all exist (default: any)
    scope: ["spec.md", "architecture/"]   # within the source dir, only these paths
    strategy: toc                 # mount | toc | both (default: both)
    ground: true                  # forbid facts not present in sources
```

Compatibility:

- Skills that omit `od.sources` work exactly as today (no source injection).
- `od.knowledge.*` is **not** carried as a deprecated alias. Skills that used the in-flight `od.knowledge` shape during this RFC's drafting must rename to `od.sources` before the implementation lands; the daemon does not silently accept the old name.
- `requires: true` with no detected sources ⇒ skill is greyed out in the picker; tooltip explains.

### `ground` semantics with multiple sources

When two or more source dirs are active in the same project, `ground` is **unioned**: if any active source dir or the skill itself has `ground: true`, the strict mode applies to the entire generation:

> "Facts (numbers, product names, dates, claims) not appearing in active sources must be marked unverified or omitted."

UI exposes this as a chip in the run header: `🔒 grounded`. Per-run override is allowed unless the skill hard-codes `ground: true`.

## UX flows

### Opening a folder

```
home screen
└─ [Open folder…]   → native folder picker → daemon resolves realpath
                    → adds to ~/.open-maker/recent-projects.json
                    → enters project view rooted at that folder
```

### "I don't have a folder yet"

```
home screen
└─ [Create folder…] → prompt for name / location (default ~/Documents/OpenDesign/<slug>-<date>/)
                    → daemon creates the dir + writes minimal project.json
                    → opens it as any other project
```

There is no "anonymous draft" path. A real directory exists from t=0 of any project's life. This is the trade we make for invariant #1 (1 project ↔ 1 directory).

### `od init` (CLI)

```
od init                       # initialize current dir as a project (writes project.json if absent)
od init ./my-pitch            # initialize a specified dir; creates if missing
od open ./my-pitch            # add to recent and open in UI (no project.json write)
```

`od init` is non-destructive: it adds `project.json` and `.od/` only; does not touch existing files.

### Recent projects

`~/.open-maker/recent-projects.json`:

```json
{
  "version": 1,
  "entries": [
    { "path": "/Users/me/Documents/foo", "lastOpenedAt": "2026-05-10T11:00:00Z" },
    { "path": "/Users/me/code/open-maker", "lastOpenedAt": "2026-05-09T20:14:11Z" }
  ]
}
```

This file is the **only** cross-project state the daemon maintains. Stale entries (path no longer exists) are dropped on startup.

## API surface changes

| Endpoint | Status | Notes |
|---|---|---|
| `POST /api/projects` (UUID-creating) | **Removed** | Replaced by `POST /api/projects/open` |
| `POST /api/import/folder` | **Removed** | Folded into `POST /api/projects/open` |
| `POST /api/projects/open` | New | Body: `{ path: string }`. Idempotent: opening the same realpath twice is a no-op. |
| `POST /api/projects/:project/facets` | New | Body: `{ mode, skill, brief, parameters? }` → 201 with facet manifest |
| `POST /api/projects/:project/facets/:facet/regen` | New | Body: `{ brief?, parameters?, keepContent? }` |
| `DELETE /api/projects/:project/facets/:facet` | New | Soft-deletes to `.od/trash/<facet-id>/` |
| `GET /api/projects/recent` | New | Reads `~/.open-maker/recent-projects.json` |
| `POST /api/chat` | Updated | Required `projectPath` parameter; rejected without it |

`:project` route segments take a URL-encoded `realpath`. The daemon canonicalizes via the same `resolveSafe` rules as today's folder import (refuse `RUNTIME_DATA_DIR` paths).

Shared DTOs added to `@open-maker/contracts`:

- `ProjectRef { path, name?, lastOpenedAt? }`
- `FacetRef`, `FacetManifest`
- `SourceDirRef`, `SourceToc`
- `OpenProjectRequest / Response`
- `CreateFacetRequest / Response`

## Boundary cases — explicit resolutions

| Case | Resolution |
|---|---|
| User moves the project folder in Finder | Next open: daemon reports "not found"; user repoints from recent-projects UI. No automatic tracking. |
| User opens the same project in two OD instances | `<project-root>/.od/lock` mutex; second instance read-only or refuses with clear message. |
| User copies the project folder | Two independent projects (different realpaths). Sessions and `.od/` cache are not shared. |
| User git-clones a sub-repo into `sources/` | Treated as a regular subdir. OD does not distinguish submodules. |
| User `rm -rf`s a project | Project disappears. Recent-projects entry is dropped on next startup. |
| User edits `artifacts/<facet>/` files in Finder | Allowed. Daemon re-reads on facet open; disk state wins. Next regen treats user edits as the new baseline (or `--keep-content` preserves them). |
| User puts a `craft/` dir inside the project | Project-local craft merges *over* the repo's craft (project wins on slug conflict). Documented in `craft/README.md`. |
| Skill requires sources but project has none | Skill greyed out in picker. Run attempts via API return 422 with `{ reason: "no-sources" }`. |
| `.od/cache/sources/<dir>/toc.json` stale after user edits sources | mtime watcher invalidates; daemon rebuilds on next compose. Cold rebuild target: < 100 ms for ~200 files. |
| Two source dirs with the same `id` (e.g., both have `KNOWLEDGE.md` declaring `name: docs`) | Daemon errors at project open with the two paths; user fixes one of the names. |

## Phasing

**Phase 1 — RFC + spec patches (this RFC review window).**
Land this draft. Patch `spec.md`, `architecture.md`, `modes.md`, `skills-protocol.md` against the agreed shape. No code yet.

**Phase 2 — Implementation (single landing, no coexistence with the old model).**
- Remove UUID-creating endpoints and `.od/projects/<uuid>/` write paths from `apps/daemon` in the same change set that introduces the new model. No deprecation period; no migration tooling.
- `apps/daemon`: project registry keyed by realpath, facet store, source resolver, ToC indexer, sibling-facet summarizer, recent-projects file at `~/.open-maker/recent-projects.json`.
- `apps/web`: project chooser screen, project view (sources panel + facet grid), facet add/regen UI.
- `packages/contracts`: new DTOs replace the old project/import shapes outright.
- Tests: `e2e` adds open-folder + facet add/regen scenarios; remove any UUID-project tests.
- Once `tools-dev` smoke and `e2e` pass on the new flow, no fallback to the old behavior remains in the codebase.

**Phase 3 — Project atoms (v2, separate RFC).**
- `project.json` gains `atoms` (headline / one-liner / audience / offer).
- Facets are forced to consume atoms; changing an atom marks dependent facets stale.
- "Hard consistency" replaces sibling-summary soft consistency.

## Documentation impact

| File | Change |
|---|---|
| `docs/spec.md` §3 (user scenarios) | Reframe S1–S5 as "open folder → generate facet" flows; S5 is the docs-driven scenario |
| `docs/architecture.md` §3.6 | Rewrite: artifacts in `<project-root>/artifacts/`, `.od/` is cache+session+history only |
| `docs/architecture.md` §7 | Update API surface table (this RFC's §"API surface changes") |
| `docs/modes.md` §6 | Add "Project as composition unit" subsection |
| `docs/modes.md` §5 | Mode selection still picks artifact shape; project context is implicit |
| `docs/skills-protocol.md` §2.1 | Add `od.sources.*` rows |
| `docs/skills-protocol.md` §5 / §5.5 | Add §5.6 "Sources as skill context" mirroring DESIGN.md/craft injection rules |
| `docs/roadmap.md` | Replace artifact-centric Phase 1/2 milestones with the project-as-unit shape; UUID model is no longer referenced anywhere |
| `craft/README.md` | Note project-local `craft/` overrides |

These patches land **after** this RFC is accepted; not in this PR.

## Out of scope

- **Project atoms / hard cross-facet consistency.** Deferred to v2 RFC.
- **Image / Video / Audio modes.** Independent RFC. This RFC's design supports them naturally as more facet types but does not define their skills or preview pipelines.
- **`@<path>` inline anchoring** in briefs (e.g., `@docs/spec.md`). Deferred to v2.
- **Cross-project source sharing.** Killed by invariant #4. Users wanting shared content copy or git-submodule it into each project.
- **Multi-user collaboration on a single project.** Out of scope; mentioned for completeness, follows MVP roadmap exclusion.
- **Project templates / scaffolding library.** A nice-to-have; tracked separately. `od init` only writes a minimal manifest.
- **Reverse flow (agent updates `sources/` based on artifacts).** Sources are read-only by convention. A separate RFC can introduce a "doc-update" facet later.
- **Embedding-based source retrieval.** Conflicts with the "no model router" non-goal in `spec.md` §6. Stay with mount + ToC.

## Open questions

1. **Default source detection list**: proposed `["sources", "docs", "content", "knowledge", "wiki"]`. Add `vault`? Drop any?
2. **`KNOWLEDGE.md` location**: project root only, or also accept `.od/KNOWLEDGE.md`? Lean: project root only — it's user content, not daemon data.
3. **Project-local `craft/` precedence**: project wins over repo, or repo wins? Lean: project wins (locality principle), with a `--strict-craft` daemon flag for environments that want to lock craft to repo-managed files.
4. **Facet IDs**: free-form strings, or constrained `[a-z0-9-]+`? Lean: constrained — they end up as directory names.
5. **`history.jsonl` granularity**: project-level only, facet-level only, or both? Lean: both, as drafted; project-level for cross-facet timeline, facet-level for surgical history. Cost is small (append-only, JSONL).
6. **Recent-projects file format version**: locked at `version: 1`, with explicit migration on bump.
7. **`od init` defaults**: should it scaffold an empty `sources/docs/`? Lean: no — keep it strictly non-destructive and let the user create directories themselves.

## Appendix A — Worked example: this repository as a project

After this RFC ships, opening `/Users/<you>/code/open-maker/` in OD does the following:

1. `POST /api/projects/open { path: "/Users/<you>/code/open-maker" }`.
2. Daemon resolves realpath, adds to recent-projects, enters project view.
3. Default source detection finds `docs/` → registers as the active source dir.
4. No `DESIGN.md` at project root → brand axis empty (skills that require it are greyed).
5. No `KNOWLEDGE.md` → project intent block omitted from compose.
6. No `artifacts/` yet → facet grid empty; chat panel shows "Generate your first facet".
7. User types: *"a SaaS-landing prototype that explains Open Maker to indie developers, hero pulls from spec.md."*
8. OD picks `saas-landing` skill (mode: prototype). Compose includes craft + ToC of `docs/` + sibling facets summary (empty) + skill body + brief.
9. Agent runs with `cwd = /Users/<you>/code/open-maker`, reads `docs/spec.md` and `docs/skills-protocol.md`, writes to `artifacts/prototype-landing/index.html`.
10. Facet grid now shows one card. Subsequent `deck-investor` facet generation receives the prototype's brief in its sibling summary and stays consistent in headline/voice.

No daemon data lives outside `<project-root>/.od/`. The repo itself is a working OD project.

## Appendix B — Why not "project = a record in a daemon DB"

Considered and rejected. A DB-backed project model would:

- Require a sync layer between DB rows and the directory the user actually edits.
- Tempt the daemon to cache content beyond mtime invalidation and drift from disk.
- Reintroduce the UUID problem for users (URL slugs, sharing references).

The user-folder-is-the-project model puts the source of truth on the filesystem, where the user already operates. Daemon state (recent-projects, agent detection cache, sessions) is strictly *secondary* and rebuildable from disk + agent re-detection.
