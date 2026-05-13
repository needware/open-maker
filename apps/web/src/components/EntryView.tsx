import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';
import { useT } from '../i18n';
import type {
  AgentInfo,
  AppConfig,
  DesignSystemSummary,
  Project,
  PromptTemplateSummary,
  SkillSummary,
} from '../types';
import type { RecentProjectEntry } from '../state/projects';
import { DesignsTab } from './DesignsTab';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';
import { DesignSystemsTab } from './DesignSystemsTab';
import { ExamplesTab } from './ExamplesTab';
import { AppChromeHeader } from './AppChromeHeader';
import { FolderPickerDialog } from './FolderPickerDialog';
import { Icon } from './Icon';
import { LanguageMenu } from './LanguageMenu';
import { CenteredLoader } from './Loading';
import { PetRail } from './pet/PetRail';
import { PromptTemplatePreviewModal } from './PromptTemplatePreviewModal';
import { PromptTemplatesTab } from './PromptTemplatesTab';
import { apiProtocolLabel } from '../utils/apiProtocol';

type TopTab = 'workspace' | 'examples' | 'design-systems' | 'image-templates' | 'video-templates';

// sessionStorage key for the "Use this prompt" hand-off. Read once by
// ProjectView after the user picks a folder, then cleared. Kept as a
// module-level constant so both writers (EntryView) and readers
// (ProjectView) can't drift out of sync.
export const PENDING_EXAMPLE_KEY = 'open-design:pending-example';

interface Props {
  // Union of functional skills + design templates — used for id-based
  // lookups (DesignsTab project chips, NewProjectPanel skill picker).
  // The Templates gallery itself reads `designTemplates` instead so it
  // doesn't accidentally show functional skills as renderable cards.
  skills: SkillSummary[];
  // Design templates only. Sourced from /api/design-templates. See
  // specs/current/skills-and-design-templates.md.
  designTemplates: SkillSummary[];
  designSystems: DesignSystemSummary[];
  projects: Project[];
  /**
   * Recent folders surfaced as the homepage's primary entry point per RFC
   * `project-as-unit.md`. Most recent first; entries with stale paths are
   * already filtered server-side.
   */
  recentProjects: RecentProjectEntry[];
  /**
   * Daemon-reported `os.homedir()`, used to tildify recent paths
   * ("/Users/me/proj" → "~/proj"), mirroring Cursor's project switcher.
   * Empty string when the daemon hasn't reported it yet (paths render
   * verbatim in that case).
   */
  recentHomeDir: string;
  promptTemplates: PromptTemplateSummary[];
  defaultDesignSystemId: string | null;
  config: AppConfig;
  agents: AgentInfo[];
  // Per-resource loading flags. Each tab gates its own content on whichever
  // flag matches the data it renders, so a slow `/api/agents` probe does
  // not block tabs that don't need agents.
  skillsLoading?: boolean;
  designSystemsLoading?: boolean;
  projectsLoading?: boolean;
  promptTemplatesLoading?: boolean;
  /**
   * Per RFC project-as-unit: the only way to start a new project is to
   * open a folder. Required (no longer optional like the pre-RFC sidebar
   * panel where it was an alternative path).
   */
  onImportFolder: (baseDir: string) => Promise<void> | void;
  onOpenProject: (id: string) => void;
  onOpenLiveArtifact: (projectId: string, artifactId: string) => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onChangeDefaultDesignSystem: (id: string) => void;
  onOpenSettings: (section?: 'execution' | 'media' | 'composio' | 'language' | 'appearance' | 'notifications' | 'pet' | 'about') => void;
  onAdoptPet: () => void;
  onAdoptPetInline: (petId: string) => void;
  onTogglePet: () => void;
}

const SIDEBAR_MIN = 320;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 380;
const SIDEBAR_STORAGE_KEY = 'od-entry-sidebar-width';
const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'open-design:connector-connected';

export function isTrustedConnectorCallbackOrigin(origin: string, currentOrigin?: string): boolean {
  const expectedOrigin = currentOrigin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  if (origin === expectedOrigin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  } catch {
    return false;
  }
}

// Lets the user fully remove the right-side pet rail from the entry
// layout. They re-summon it from the entry-view avatar dropdown — the
// PetRail's own collapse toggle only narrows the column, so this state
// is the "the rail isn't there at all" escape hatch.
const PET_RAIL_HIDDEN_KEY = 'open-design:pet-rail-hidden';

function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) return SIDEBAR_DEFAULT;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return SIDEBAR_DEFAULT;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function sortConnectorsForDisplay(connectors: ConnectorDetail[]): ConnectorDetail[] {
  return [...connectors].sort((a, b) => {
    const aConnected = a.status === 'connected';
    const bConnected = b.status === 'connected';
    if (aConnected !== bConnected) return aConnected ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  });
}

function normalizedSearchValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function scoreConnectorText(value: string | undefined, query: string, baseScore: number): number | null {
  const normalized = normalizedSearchValue(value);
  if (!normalized) return null;
  if (normalized === query) return baseScore;
  if (normalized.startsWith(query)) return baseScore + 1;
  if (normalized.includes(query)) return baseScore + 2;
  return null;
}

export function getConnectorSearchScore(connector: ConnectorDetail, query: string): number | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const scores: number[] = [];
  const collect = (value: string | undefined, baseScore: number) => {
    const score = scoreConnectorText(value, normalizedQuery, baseScore);
    if (score !== null) scores.push(score);
  };

  // Connector identity fields carry the most intent: exact and prefix
  // name/provider matches should beat incidental mentions elsewhere.
  collect(connector.name, 0);
  collect(connector.provider, 0);

  // Secondary connector metadata is still searchable, but lower priority.
  collect(connector.category, 3);
  collect(connector.accountLabel, 3);

  // Tool names/titles are more relevant than prose descriptions, but below
  // connector-level identity matches.
  for (const tool of connector.tools) {
    collect(tool.title, 5);
    collect(tool.name, 5);
  }

  // Prose descriptions are broad and often mention other products, so they
  // are intentionally down-ranked rather than excluded.
  collect(connector.description, 8);
  for (const tool of connector.tools) {
    collect(tool.description, 8);
  }

  return scores.length ? Math.min(...scores) : null;
}

export function sortConnectorsForSearch(
  connectors: ConnectorDetail[],
  query: string,
): ConnectorDetail[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return sortConnectorsForDisplay(connectors);

  return [...connectors]
    .map((connector) => ({ connector, score: getConnectorSearchScore(connector, normalizedQuery) }))
    .filter((entry): entry is { connector: ConnectorDetail; score: number } => entry.score !== null)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const aConnected = a.connector.status === 'connected';
      const bConnected = b.connector.status === 'connected';
      if (aConnected !== bConnected) return aConnected ? -1 : 1;
      return (
        a.connector.name.localeCompare(b.connector.name, undefined, { sensitivity: 'base' }) ||
        a.connector.id.localeCompare(b.connector.id)
      );
    })
    .map((entry) => entry.connector);
}

function loadPetRailHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PET_RAIL_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function EntryView({
  skills,
  designTemplates,
  designSystems,
  projects,
  recentProjects,
  recentHomeDir,
  promptTemplates,
  defaultDesignSystemId,
  config,
  agents,
  skillsLoading = false,
  designSystemsLoading = false,
  projectsLoading = false,
  promptTemplatesLoading = false,
  onImportFolder,
  onImportFolderResponse,
  onOpenProject,
  onOpenLiveArtifact,
  onDeleteProject,
  onRenameProject,
  onChangeDefaultDesignSystem,
  onOpenSettings,
  onAdoptPet,
  onAdoptPetInline,
  onTogglePet,
}: Props) {
  const t = useT();
  const [topTab, setTopTab] = useState<TopTab>('workspace');
  const [previewSystemId, setPreviewSystemId] = useState<string | null>(null);
  const [previewPromptTemplate, setPreviewPromptTemplate] =
    useState<PromptTemplateSummary | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  const [resizing, setResizing] = useState(false);
  const [petRailHidden, setPetRailHiddenState] = useState<boolean>(() => loadPetRailHidden());
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const avatarMenuRef = useRef<HTMLDivElement | null>(null);
  // Folder-picker dialog state. Single dialog instance shared by every
  // "click to pick a folder" entry point (sidebar hero, switcher popover
  // bottom action, switcher popover input fallback). `pickerInitial` is
  // optional — defaults to the daemon-reported home dir.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInitial, setPickerInitial] = useState<string | undefined>(undefined);

  function openFolderPicker(initialPath?: string) {
    setPickerInitial(initialPath ?? (recentHomeDir || undefined));
    setPickerOpen(true);
  }

  function setPetRailHidden(next: boolean) {
    setPetRailHiddenState(next);
    try {
      window.localStorage.setItem(PET_RAIL_HIDDEN_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );

  const envMetaLine = useMemo(() => {
    if (config.mode === 'api') {
      try {
        return `${config.model} · ${new URL(config.baseUrl).host}`;
      } catch {
        return config.model;
      }
    }
    return currentAgent
      ? `${currentAgent.name}${currentAgent.version ? ` · ${currentAgent.version}` : ''}`
      : t('settings.noAgentSelected');
  }, [config.mode, config.model, config.baseUrl, currentAgent, t]);

  // RFC project-as-unit: every facet lives inside a folder the user
  // owns, so 'Use this prompt' can no longer create a project on the
  // fly. Instead we stash the user's intent (skill + example prompt)
  // in sessionStorage, then open the folder picker. After the user
  // picks a folder, ProjectView mounts and consumes the stash on
  // first render — auto-selecting the skill and pre-filling the
  // composer with the example prompt. Single-use; the stash is
  // cleared after consumption so reloading later doesn't replay it.
  function usePromptFromSkill(skill: SkillSummary) {
    try {
      window.sessionStorage.setItem(
        PENDING_EXAMPLE_KEY,
        JSON.stringify({
          skillId: skill.id,
          prompt: skill.examplePrompt ?? '',
          createdAt: Date.now(),
        }),
      );
    } catch {
      // Safari private mode etc. — fall back to opening the picker
      // without the stash; user just doesn't get auto-prefill.
    }
    openFolderPicker();
  }

  function previewDesignSystem(id: string) {
    setPreviewSystemId(id);
  }

  const previewSystem = useMemo(
    () => (previewSystemId ? designSystems.find((d) => d.id === previewSystemId) ?? null : null),
    [designSystems, previewSystemId],
  );

  const startWidthRef = useRef(0);
  const startXRef = useRef(0);

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - startXRef.current;
      const next = Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, startWidthRef.current + dx),
      );
      setSidebarWidth(next);
    }
    function onUp() {
      setResizing(false);
    }
    document.body.classList.add('entry-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.classList.remove('entry-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
    } catch {
      /* ignore */
    }
  }, [sidebarWidth]);

  // Connector list / OAuth status refresh used to live here to populate the
  // pre-RFC NewProjectPanel's live-artifact tab. With the panel removed,
  // connectors now load lazily inside the Settings dialog only — no need to
  // pre-fetch them on the home screen. The `applyConnectorStatuses` helper
  // and `CONNECTOR_CALLBACK_MESSAGE_TYPE` constant are kept above so the
  // OAuth callback handler in `apps/web/src/oauth-callback.html` can still
  // postMessage to a future settings panel.

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!avatarMenuRef.current) return;
      if (!avatarMenuRef.current.contains(e.target as Node)) {
        setAvatarMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAvatarMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [avatarMenuOpen]);

  const avatarMenu = (
    <div className="avatar-menu" ref={avatarMenuRef}>
      <button
        type="button"
        className="settings-icon-btn"
        onClick={() => setAvatarMenuOpen((v) => !v)}
        title={t('entry.openSettingsTitle')}
        aria-label={t('entry.openSettingsAria')}
        aria-haspopup="menu"
        aria-expanded={avatarMenuOpen}
      >
        <Icon name="settings" size={17} />
      </button>
      {avatarMenuOpen ? (
        <div className="avatar-popover" role="menu">
          <button
            type="button"
            className="avatar-item"
            onClick={() => {
              setPetRailHidden(!petRailHidden);
              setAvatarMenuOpen(false);
            }}
          >
            <span className="avatar-item-icon" aria-hidden>
              <Icon name={petRailHidden ? 'sparkles' : 'eye'} size={14} />
            </span>
            <span>
              {petRailHidden ? t('pet.railShow') : t('pet.railHide')}
            </span>
          </button>
          <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 6px' }} />
          <button
            type="button"
            className="avatar-item"
            onClick={() => {
              setAvatarMenuOpen(false);
              onOpenSettings();
            }}
          >
            <span className="avatar-item-icon" aria-hidden>
              <Icon name="settings" size={14} />
            </span>
            <span>{t('avatar.settings')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="entry-shell">
      <AppChromeHeader actions={avatarMenu}>
        <ProjectSwitcherTrigger
          activeLabel="Home"
          recentProjects={recentProjects}
          homeDir={recentHomeDir}
          onImportFolder={onImportFolder}
          onOpenPicker={openFolderPicker}
        />
      </AppChromeHeader>
      <FolderPickerDialog
        open={pickerOpen}
        initialPath={pickerInitial}
        onClose={() => setPickerOpen(false)}
        onOpen={(p) => {
          void onImportFolder(p);
        }}
      />
      <div
        className={`entry${petRailHidden ? '' : ' has-pet-rail'}`}
        style={{
          gridTemplateColumns: petRailHidden
            ? `${sidebarWidth}px 1fr`
            : `${sidebarWidth}px 1fr auto`,
        }}
      >
      <aside className="entry-side" style={{ width: sidebarWidth }}>
        <SidebarHero onOpenPicker={openFolderPicker} />
        <div className="entry-side-foot">
          <button
            type="button"
            className="foot-pill foot-pill-env"
            onClick={() => onOpenSettings()}
            aria-label={t('settings.envConfigure')}
            title={t('settings.envConfigure')}
          >
            <Icon name="settings" size={12} />
            <span>
              {config.mode === 'daemon'
                ? t('settings.localCli')
                : apiProtocolLabel(config.apiProtocol)}
            </span>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
              {envMetaLine}
            </span>
          </button>
          <div className="entry-side-foot-row">
            <LanguageMenu />
            <div className={`foot-pill pet-pill${config.pet?.adopted ? '' : ' pet-pill-fresh'}`}>
              <button
                type="button"
                className="pet-pill-main"
                onClick={onAdoptPet}
                title={
                  config.pet?.adopted
                    ? t('pet.changePet')
                    : t('pet.adoptCallout')
                }
              >
                <span className="pet-pill-glyph" aria-hidden>
                  {config.pet?.adopted
                    ? config.pet.petId === 'custom'
                      ? config.pet.custom.glyph || '🦄'
                      : '🐾'
                    : '🐾'}
                </span>
                <span className="foot-pill-pet-label">
                  {config.pet?.adopted
                    ? t('pet.changePet')
                    : t('pet.adoptCallout')}
                </span>
                {!config.pet?.adopted ? <span className="pet-pill-dot" aria-hidden /> : null}
              </button>
              <span className="pet-pill-divider" aria-hidden />
              <button
                type="button"
                className="pet-pill-toggle"
                onClick={() => setPetRailHidden(!petRailHidden)}
                aria-label={petRailHidden ? t('pet.railShow') : t('pet.railHide')}
                title={petRailHidden ? t('pet.railShow') : t('pet.railHide')}
              >
                <Icon name={petRailHidden ? 'eye' : 'eye-off'} size={12} />
              </button>
            </div>
            <a
              className="foot-pill foot-pill-follow"
              href="https://discord.com/invite/qhbcCH8Am4"
              target="_blank"
              rel="noreferrer noopener"
              title="Join the Open Design Discord community"
              aria-label="Join the Open Design Discord community"
            >
              <Icon name="discord" size={12} />
            </a>
            <a
              className="foot-pill foot-pill-follow"
              href="https://x.com/nexudotio"
              target="_blank"
              rel="noreferrer noopener"
              title="Follow @nexudotio on X for releases and milestones"
              aria-label="Follow @nexudotio on X"
            >
              <Icon name="external-link" size={12} />
            </a>
          </div>
        </div>
        <button
          type="button"
          aria-label={t('entry.resizeAria')}
          className={`entry-side-resizer${resizing ? ' dragging' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            startWidthRef.current = sidebarWidth;
            startXRef.current = e.clientX;
            setResizing(true);
          }}
        />
      </aside>
      <main className="entry-main">
        <div className="entry-header">
          <div className="entry-tabs" role="tablist">
            <TopTabButton current={topTab} value="workspace" label={t('entry.tabWorkspace')} onClick={setTopTab} />
            <TopTabButton current={topTab} value="examples" label={t('entry.tabExamples')} onClick={setTopTab} />
            <TopTabButton
              current={topTab}
              value="design-systems"
              label={t('entry.tabDesignSystems')}
              onClick={setTopTab}
            />
            <TopTabButton
              current={topTab}
              value="image-templates"
              label={t('entry.tabImageTemplates')}
              onClick={setTopTab}
            />
            <TopTabButton
              current={topTab}
              value="video-templates"
              label={t('entry.tabVideoTemplates')}
              onClick={setTopTab}
            />
          </div>
        </div>
        <div className="entry-tab-content">
          {topTab === 'workspace' ? (
            // DesignsTab uses skills + designSystems for tag rendering on
            // each card, so wait until projects + that metadata are present
            // to avoid a flash of "No projects yet" before the real list
            // arrives.
            projectsLoading || skillsLoading || designSystemsLoading ? (
              <CenteredLoader label={t('common.loading')} />
            ) : (
              <DesignsTab
                projects={projects}
                skills={skills}
                designSystems={designSystems}
                onOpen={onOpenProject}
                onOpenLiveArtifact={onOpenLiveArtifact}
                onDelete={onDeleteProject}
                onRename={onRenameProject}
              />
            )
          ) : null}
          {topTab === 'templates' ? (
            skillsLoading ? (
              <CenteredLoader label={t('common.loading')} />
            ) : (
              <ExamplesTab
                skills={designTemplates}
                onUsePrompt={usePromptFromSkill}
              />
            )
          ) : null}
          {topTab === 'design-systems' ? (
            designSystemsLoading ? (
              <CenteredLoader label={t('common.loading')} />
            ) : (
              <DesignSystemsTab
                systems={designSystems}
                selectedId={defaultDesignSystemId}
                onSelect={onChangeDefaultDesignSystem}
                onPreview={previewDesignSystem}
              />
            )
          ) : null}
          {topTab === 'image-templates' ? (
            promptTemplatesLoading ? (
              <CenteredLoader label={t('common.loading')} />
            ) : (
              <PromptTemplatesTab
                surface="image"
                templates={promptTemplates}
                onPreview={setPreviewPromptTemplate}
              />
            )
          ) : null}
          {topTab === 'video-templates' ? (
            promptTemplatesLoading ? (
              <CenteredLoader label={t('common.loading')} />
            ) : (
              <PromptTemplatesTab
                surface="video"
                templates={promptTemplates}
                onPreview={setPreviewPromptTemplate}
              />
            )
          ) : null}
        </div>
      </main>
      {petRailHidden ? null : (
        <PetRail
          config={config}
          onAdoptInline={onAdoptPetInline}
          onOpenPetSettings={onAdoptPet}
          onTuck={onTogglePet}
          onHide={() => setPetRailHidden(true)}
        />
      )}
      </div>
      {previewSystem ? (
        <DesignSystemPreviewModal
          system={previewSystem}
          onClose={() => setPreviewSystemId(null)}
        />
      ) : null}
      {previewPromptTemplate ? (
        <PromptTemplatePreviewModal
          summary={previewPromptTemplate}
          onClose={() => setPreviewPromptTemplate(null)}
        />
      ) : null}
    </div>
  );
}

function TopTabButton({
  current,
  value,
  label,
  onClick,
}: {
  current: TopTab;
  value: TopTab;
  label: string;
  onClick: (v: TopTab) => void;
}) {
  return (
    <button
      role="tab"
      data-testid={`entry-tab-${value}`}
      aria-selected={current === value}
      className={`entry-tab ${current === value ? 'active' : ''}`}
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

/**
 * Project-switcher trigger — a header chip ("Home ▾" on the home view,
 * project name when one is open) that toggles a Cursor-style popover
 * containing the recents list + Set Up Workspace action. Lifted out of the
 * sidebar so the project switcher works the same way on the home screen
 * and inside a project (slice 5 will reuse this trigger in the project
 * shell's chrome).
 *
 * Mouse + keyboard interaction follows the existing avatar menu pattern
 * elsewhere in this file: outside-click closes, Escape closes, the
 * trigger advertises `aria-haspopup`/`aria-expanded` for screen readers.
 */
function ProjectSwitcherTrigger({
  activeLabel,
  recentProjects,
  homeDir,
  onImportFolder,
  onOpenPicker,
}: {
  /** Text shown in the trigger button. "Home" on the launcher; the
   *  project's display name once a project is open. */
  activeLabel: string;
  recentProjects: RecentProjectEntry[];
  homeDir: string;
  onImportFolder?: (path: string) => Promise<void> | void;
  /** Open the in-app folder picker dialog. Used as the click-to-pick
   *  fallback when `window.electronAPI.pickFolder` is unavailable. */
  onOpenPicker?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The popover renders with `position: fixed` so it can escape the
  // header's `overflow: hidden` clip (`.app-chrome-content` clips its
  // descendants). We re-measure the trigger every time the popover
  // opens (and on viewport resize while open) so the popover sticks to
  // the trigger as the window resizes.
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  function refreshAnchor() {
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setAnchorRect({ left: r.left, top: r.bottom + 4 });
  }

  useEffect(() => {
    if (!open) return;
    refreshAnchor();
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => refreshAnchor();
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open]);

  // Close after a successful open — the trigger label is about to change
  // anyway when the project view loads, so keeping the popover up would
  // flash stale state.
  const handleImportFolder = onImportFolder
    ? async (p: string) => {
        await onImportFolder(p);
        setOpen(false);
      }
    : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="project-switcher-trigger"
        data-testid="project-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: open ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'transparent',
          border: 'none',
          borderRadius: 6,
          color: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          // -webkit-app-region opt-out so the button stays clickable in
          // the macOS title-bar drag region (the rest of the chrome is
          // draggable via the `app-chrome-drag` element).
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span>{activeLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && anchorRect ? (
        <div
          ref={popoverRef}
          role="menu"
          data-testid="project-switcher-popover"
          style={{
            position: 'fixed',
            left: anchorRect.left,
            top: anchorRect.top,
            zIndex: 1000,
            width: 360,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--surface, var(--surface-soft, #fff))',
            border: '1px solid var(--border-soft)',
            borderRadius: 10,
            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)',
            padding: '10px 8px 8px',
            // Constrain to viewport so a long Recents list doesn't push
            // the popover off-screen on small displays.
            maxHeight: 'min(70vh, 520px)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ProjectSwitcherPanel
            recentProjects={recentProjects}
            homeDir={homeDir}
            onImportFolder={handleImportFolder}
            onOpenPicker={
              onOpenPicker
                ? () => {
                    setOpen(false);
                    onOpenPicker();
                  }
                : undefined
            }
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * Sidebar hero shown on the home screen. The full project switcher now
 * lives in the header popover (see `ProjectSwitcherTrigger`), so the
 * sidebar is just a friendly explainer + a single shortcut to the
 * folder picker. Still useful: gives the empty homepage a focal point
 * and a one-click escape route from "what do I do here?".
 *
 * The "Set Up Workspace" button prefers the native Electron picker when
 * available (better UX on macOS/Windows) and falls back to the
 * in-app `FolderPickerDialog` otherwise (browser dev / headless tests
 * / Linux distros without a system dialog). The fallback dialog talks
 * to the daemon's `/api/fs/ls` endpoint to walk real OS paths — which
 * is what the project-as-unit model needs (web-only `<input
 * webkitdirectory>` returns a virtualized path the daemon can't read).
 */
function SidebarHero({
  onOpenPicker,
}: {
  /** Open the in-app folder picker dialog. EntryView routes the
   *  confirmed path through `onImportFolder` for both this hero and the
   *  switcher popover, so the dialog only needs an opener here. */
  onOpenPicker: () => void;
}) {
  return (
    <div
      className="entry-sidebar-hero"
      data-testid="entry-sidebar-hero"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 24,
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Open a folder to begin
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0, lineHeight: 1.55 }}>
          A project is a folder on your disk. Open one and Open Design
          generates everything — sources, brand, facets — inside it.
        </p>
      </div>

      <button
        type="button"
        className="foot-pill"
        onClick={onOpenPicker}
        data-testid="sidebar-hero-pick"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: '10px 14px',
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        <Icon name="folder" size={14} />
        <span>Set Up Workspace</span>
      </button>

      <p
        style={{
          fontSize: 12,
          color: 'var(--text-faint)',
          margin: 0,
          lineHeight: 1.55,
        }}
      >
        Or click <strong>Home ▾</strong> in the title bar to switch
        between recent folders.
      </p>
    </div>
  );
}

/**
 * Popover-content version of the project switcher. Renders the search
 * input, "Recents" list, and bottom Set Up Workspace action — exactly the
 * three groups in Cursor's reference popover (`docs/.../image-…png`).
 *
 * The search input is also the manual-path fallback: when the typed text
 * doesn't match any recent entry and the user presses Enter (or clicks
 * the matching action), it's treated as a path to open. `~/` is expanded
 * client-side using the daemon-reported home dir so users can paste
 * `~/projects/foo` exactly as they would in a terminal.
 */
function ProjectSwitcherPanel({
  recentProjects,
  homeDir,
  onImportFolder,
  onOpenPicker,
}: {
  recentProjects: RecentProjectEntry[];
  homeDir: string;
  onImportFolder?: (path: string) => Promise<void> | void;
  /** Open the in-app folder picker dialog. The popover prefers the
   *  native Electron picker when available; the dialog is the
   *  cross-platform fallback driven by the daemon's `/api/fs/ls`. */
  onOpenPicker?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const hasElectronPicker =
    typeof window !== 'undefined' && typeof window.electronAPI?.pickFolder === 'function';

  // Filter the recent list against the query. Match against both the
  // tildified label (what the user sees) and the raw absolute path so
  // typing the basename or the leading `~/...` both work. Empty query
  // shows the full list so the panel still feels populated on first load.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recentProjects;
    return recentProjects.filter((entry) => {
      const label = tildify(entry.path, homeDir).toLowerCase();
      return label.includes(q) || entry.path.toLowerCase().includes(q);
    });
  }, [query, recentProjects, homeDir]);

  async function handlePick() {
    if (!onImportFolder || !hasElectronPicker) return;
    setBusy(true);
    try {
      const picked = await window.electronAPI!.pickFolder!();
      if (!picked) return;
      await onImportFolder(picked);
    } finally {
      setBusy(false);
    }
  }

  function handleOpenEntry(p: string) {
    if (!onImportFolder || busy) return;
    void onImportFolder(p);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!onImportFolder) return;
    const trimmed = query.trim();
    if (!trimmed) return;
    // If the query exactly matches a tildified label or absolute path,
    // re-use that entry (de-dupes against the canonical realpath the
    // daemon returned). Otherwise treat the input as a fresh path.
    const exactRecent = recentProjects.find(
      (e2) => tildify(e2.path, homeDir) === trimmed || e2.path === trimmed,
    );
    const target = exactRecent ? exactRecent.path : expandHome(trimmed, homeDir);
    setBusy(true);
    try {
      await onImportFolder(target);
      setQuery('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="project-switcher-panel"
      data-testid="project-switcher-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <form onSubmit={handleSubmit} style={{ marginBottom: 8, padding: '0 4px' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Open a folder…"
          spellCheck={false}
          autoComplete="off"
          data-testid="project-switcher-input"
          disabled={busy}
          style={{
            width: '100%',
            padding: '8px 10px',
            border: '1px solid var(--border-soft)',
            borderRadius: 6,
            background: 'var(--surface-soft, transparent)',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </form>

      {recentProjects.length > 0 ? (
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-faint)',
            padding: '6px 8px 4px',
            letterSpacing: 0.2,
          }}
        >
          Recents
        </div>
      ) : null}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          margin: '0 -4px',
        }}
      >
        {filtered.map((entry) => (
          <SwitcherRow
            key={entry.path}
            label={tildify(entry.path, homeDir)}
            title={entry.path}
            onClick={() => handleOpenEntry(entry.path)}
          />
        ))}
        {recentProjects.length > 0 && filtered.length === 0 ? (
          <div
            style={{
              padding: '10px 12px',
              fontSize: 12,
              color: 'var(--text-faint)',
            }}
          >
            No matches. Press Enter to open “{query.trim()}”.
          </div>
        ) : null}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border-soft)',
          paddingTop: 6,
          margin: '0 -4px',
        }}
      >
        <SwitcherRow
          label={busy ? 'Opening…' : 'Set Up Workspace'}
          onClick={hasElectronPicker ? handlePick : (onOpenPicker ?? (() => {}))}
          testId="project-switcher-pick"
          disabled={busy || (!hasElectronPicker && !onOpenPicker)}
        />
      </div>
    </div>
  );
}

/**
 * One row in the Cursor-style project switcher. A folder icon followed
 * by a single line of text. Hover gives the standard list-item feel
 * (subtle bg) without leaning on a class that lives elsewhere — keeps
 * the component self-contained.
 */
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
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId ?? 'project-switcher-row'}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title ?? label}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 10px',
        background: hover && !disabled ? 'var(--surface-hover, rgba(0,0,0,0.04))' : 'transparent',
        border: 'none',
        borderRadius: 6,
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        color: 'inherit',
        fontSize: 13,
        opacity: disabled ? 0.6 : 1,
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
        {label}
      </span>
    </button>
  );
}

/**
 * Convert an absolute path to its `~/`-prefixed display form when it
 * lives under `homeDir`. Falls back to the raw path otherwise. Trailing
 * slashes are normalized so `/Users/me/` and `/Users/me` both produce
 * `~`. Inverse of `expandHome`.
 */
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

/**
 * Expand a leading `~` / `~/...` segment into an absolute path using the
 * daemon-reported home dir. Inverse of `tildify`. Inputs that don't
 * start with `~` are returned unchanged so absolute or workspace-relative
 * paths still round-trip through `/api/projects/open` (the daemon
 * resolves both).
 */
export function expandHome(input: string, homeDir: string): string {
  if (!input) return input;
  if (!homeDir) return input;
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return homeDir.replace(/[\\/]+$/, '') + input.slice(1);
  }
  return input;
}

