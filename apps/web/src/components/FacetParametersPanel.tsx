// FacetParametersPanel — restored from the pre-RFC NewProjectPanel
// (commit e73d4fb6^). RFC project-as-unit moved project creation to
// the folder picker, but the per-facet parameter controls (fidelity,
// speaker notes, animations, media model/aspect/length, prompt
// templates, design system pickers) still apply once the project
// exists. This component mounts inside FacetSetupPopover and pushes
// every change up via `onChange`; the parent persists into
// `project.skillId` / `project.designSystemId` / `project.metadata`.
//
// What's removed vs. the original:
//   - Project name <input> (folder name = project name)
//   - "Create" button (the project already exists by this point)
//   - Claude-design zip import + folder picker (handled at folder-pick
//     time on the homepage)
//   - "Privacy footer" string (rendered elsewhere now)
// Everything else — including all helper sub-components — is preserved
// so the per-tab operation panel reads identically to the old form.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { fetchPromptTemplate } from '../providers/registry';
import { isStoredMediaProviderEntryPresent } from '../state/config';
import type {
  AudioKind,
  DesignSystemSummary,
  MediaAspect,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  MediaProviderCredentials,
  PromptTemplateSummary,
  SkillSummary,
} from '../types';
import {
  AUDIO_DURATIONS_SEC,
  AUDIO_MODELS_BY_KIND,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  findProvider,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  type MediaModel,
  VIDEO_LENGTHS_SEC,
  VIDEO_MODELS,
} from '../media/models';
import { Icon } from './Icon';
import { Skeleton } from './Loading';

// Snapshot of a curated prompt template, captured at New Project time and
// folded into ProjectMetadata.promptTemplate. The user may have edited the
// prompt body before clicking Create — that edited copy lives here.
type PromptTemplatePick = {
  summary: PromptTemplateSummary;
  prompt: string;
};

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// CreateTab is a UI-only enum: it defines the eight tabs in the
// FacetSetupPopover. `live-artifact` and `other` are *not* contract
// FacetMode values — they're surfaced as separate tabs but resolve to
// `prototype` skills (with `intent: 'live-artifact'` metadata) and
// "no skill" respectively. Keeping the same name as the original so
// helper functions (`titleForTab`, `autoName`, `buildMetadata`) stay
// usable verbatim.
export type CreateTab = 'prototype' | 'live-artifact' | 'deck' | 'template' | 'image' | 'video' | 'audio' | 'other';

export interface FacetSelection {
  skillId: string | null;
  designSystemId: string | null;
  metadata: ProjectMetadata;
}

// Every metadata key the FacetParametersPanel writes. The panel is the
// sole authority on these — when a tab change produces a new
// FacetSelection.metadata, any previously-set panel-owned key that is
// *not* present in the new payload must be cleared, otherwise stale
// fields (e.g. `intent: 'live-artifact'` after switching to the Video
// tab) bleed across tabs and the FacetModeChip keeps reading the
// previous mode. `kind` is intentionally excluded — `buildMetadata`
// always sets it, so it's covered by the spread of `next` below.
const FACET_PANEL_OWNED_KEYS = new Set<keyof ProjectMetadata>([
  'intent',
  'fidelity',
  'speakerNotes',
  'animations',
  'templateId',
  'templateLabel',
  'imageModel',
  'imageAspect',
  'imageStyle',
  'videoModel',
  'videoLength',
  'videoAspect',
  'audioKind',
  'audioModel',
  'audioDuration',
  'voice',
  'promptTemplate',
  'inspirationDesignSystemIds',
]);

/**
 * Pick the default skill the panel should auto-bind when the user
 * lands on a given tab. The `image`/`video`/`audio` tabs are the
 * tricky case: hyperframes-style template skills carry `surface:
 * video` while their `mode` is `template`, so a naïve
 * `mode === tab || surface === tab` filter leaks them into the media
 * tab's candidate pool — and when none of the true media skills
 * declares `default_for: <tab>`, we'd accidentally seed the project
 * with a `mode: template` skill. The FacetModeChip then derives its
 * mode from `skill.mode` and renders "From template" while the
 * popover stays on the Video tab. Prefer mode-matches first; only
 * fall back to surface-matches when no skill claims the mode at all.
 */
export function pickDefaultSkillIdForTab(
  tab: CreateTab,
  skills: SkillSummary[],
): string | null {
  if (tab === 'other') return null;
  if (tab === 'prototype') {
    const list = skills.filter((s) => s.mode === 'prototype');
    return (
      list.find((s) => s.defaultFor.includes('prototype'))?.id ??
      list[0]?.id ??
      null
    );
  }
  if (tab === 'live-artifact') {
    const exact = skills.find(
      (s) => s.id === 'live-artifact' || s.name === 'live-artifact',
    );
    if (exact) return exact.id;
    const hinted = skills.find((s) => {
      const haystack =
        `${s.id} ${s.name} ${s.description} ${s.triggers.join(' ')}`.toLowerCase();
      return (
        haystack.includes('live artifact') || haystack.includes('live-artifact')
      );
    });
    if (hinted) return hinted.id;
    const prototypes = skills.filter((s) => s.mode === 'prototype');
    return (
      prototypes.find((s) => s.defaultFor.includes('prototype'))?.id ??
      prototypes[0]?.id ??
      null
    );
  }
  if (tab === 'deck') {
    const list = skills.filter((s) => s.mode === 'deck');
    return (
      list.find((s) => s.defaultFor.includes('deck'))?.id ??
      list[0]?.id ??
      null
    );
  }
  if (tab === 'template') {
    return null;
  }
  // image / video / audio: media tabs.
  const modeMatches = skills.filter((s) => s.mode === tab);
  const surfaceFallback = skills.filter(
    (s) => s.mode !== tab && s.surface === tab,
  );
  const candidates = modeMatches.length > 0 ? modeMatches : surfaceFallback;
  return (
    candidates.find((s) => s.defaultFor.includes(tab))?.id ??
    candidates[0]?.id ??
    null
  );
}

/**
 * Merge a fresh `FacetSelection.metadata` into the project's existing
 * metadata. Panel-owned fields are *replaced wholesale* by `next` (so
 * tab switches reliably drop fields that don't apply to the new tab),
 * while system-owned fields the panel never touches (`baseDir`,
 * `importedFrom`, `entryFile`, `sourceFileName`, `linkedDirs`, …) are
 * carried forward from `existing`.
 */
export function mergeFacetMetadata(
  existing: ProjectMetadata | undefined,
  next: ProjectMetadata,
): ProjectMetadata {
  if (!existing) return next;
  const existingBag = existing as unknown as Record<string, unknown>;
  const resultBag: Record<string, unknown> = { ...next };
  for (const key of Object.keys(existing) as Array<keyof ProjectMetadata>) {
    if (key === 'kind') continue;
    if (FACET_PANEL_OWNED_KEYS.has(key)) continue;
    if (key in resultBag) continue;
    resultBag[key] = existingBag[key];
  }
  return resultBag as unknown as ProjectMetadata;
}

interface Props {
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  promptTemplates: PromptTemplateSummary[];
  // Initial / current selection. The panel uses these on first render
  // and to drive the active tab; subsequent changes flow back via
  // `onChange` so the parent keeps a single source of truth.
  currentSkillId: string | null;
  currentDesignSystemId: string | null;
  currentMetadata?: ProjectMetadata;
  // Fires on every parameter change. The parent typically persists
  // via `patchProject({ skillId, designSystemId, metadata })`.
  onChange: (next: FacetSelection) => void;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  connectors?: ConnectorDetail[];
  connectorsLoading?: boolean;
  onOpenConnectorsTab?: () => void;
}

const TAB_LABEL_KEYS: Record<CreateTab, keyof Dict> = {
  prototype: 'newproj.tabPrototype',
  'live-artifact': 'newproj.tabLiveArtifact',
  deck: 'newproj.tabDeck',
  template: 'newproj.tabTemplate',
  image: 'newproj.surfaceImage',
  video: 'newproj.surfaceVideo',
  audio: 'newproj.surfaceAudio',
  other: 'newproj.tabOther',
};

export function defaultDesignSystemSelection(
  defaultDesignSystemId: string | null,
  designSystems: DesignSystemSummary[],
): string[] {
  if (!defaultDesignSystemId) return [];
  return designSystems.some((d) => d.id === defaultDesignSystemId)
    ? [defaultDesignSystemId]
    : [];
}

export function buildDesignSystemCreateSelection(
  showDesignSystemPicker: boolean,
  selectedIds: string[],
): { primary: string | null; inspirations: string[] } {
  return showDesignSystemPicker
    ? {
        primary: selectedIds[0] ?? null,
        inspirations: selectedIds.slice(1),
      }
    : { primary: null, inspirations: [] };
}

export function FacetParametersPanel({
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  promptTemplates,
  currentSkillId,
  currentDesignSystemId,
  currentMetadata,
  onChange,
  mediaProviders,
  connectors,
  connectorsLoading = false,
  onOpenConnectorsTab,
}: Props) {
  const t = useT();
  const [tab, setTab] = useState<CreateTab>(() =>
    deriveTabFromSelection(currentSkillId, currentMetadata, skills),
  );
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });

  // Design-system selection is an array internally so this component
  // can drive both single-select (default) and multi-select (with
  // "additional inspirations") without duplicating state.
  const initialDsSelection = useMemo(() => {
    const seed = [
      currentDesignSystemId,
      ...((currentMetadata?.inspirationDesignSystemIds ?? []) as string[]),
    ].filter((id): id is string => Boolean(id));
    if (seed.length > 0) return seed;
    return defaultDesignSystemSelection(defaultDesignSystemId, designSystems);
  }, [currentDesignSystemId, currentMetadata, defaultDesignSystemId, designSystems]);
  const [selectedDsIds, setSelectedDsIds] = useState<string[]>(initialDsSelection);
  const [dsSelectionTouched, setDsSelectionTouched] = useState(
    () => Boolean(currentDesignSystemId),
  );
  const [dsMulti, setDsMulti] = useState(
    () => (currentMetadata?.inspirationDesignSystemIds?.length ?? 0) > 0,
  );

  // Per-tab metadata, seeded from `currentMetadata` so the popover
  // reflects what's already saved on the project. Tracked independently
  // so switching tabs preserves each tab's pick rather than resetting
  // to defaults.
  const [fidelity, setFidelity] = useState<'wireframe' | 'high-fidelity'>(
    currentMetadata?.fidelity ?? 'high-fidelity',
  );
  const [speakerNotes, setSpeakerNotes] = useState(
    currentMetadata?.speakerNotes ?? false,
  );
  const [animations, setAnimations] = useState(
    currentMetadata?.animations ?? false,
  );
  const [templateId, setTemplateId] = useState<string | null>(
    currentMetadata?.templateId ?? null,
  );
  const [imageModel, setImageModel] = useState(
    currentMetadata?.imageModel ?? DEFAULT_IMAGE_MODEL,
  );
  const [imageAspect, setImageAspect] = useState<MediaAspect>(
    currentMetadata?.imageAspect ?? '1:1',
  );
  const [imageStyle, setImageStyle] = useState(currentMetadata?.imageStyle ?? '');
  const [videoModel, setVideoModel] = useState(
    currentMetadata?.videoModel ?? DEFAULT_VIDEO_MODEL,
  );
  const [videoAspect, setVideoAspect] = useState<MediaAspect>(
    currentMetadata?.videoAspect ?? '16:9',
  );
  const [videoLength, setVideoLength] = useState(currentMetadata?.videoLength ?? 5);
  const [audioKind, setAudioKind] = useState<AudioKind>(
    currentMetadata?.audioKind ?? 'speech',
  );
  const [audioModel, setAudioModel] = useState(
    currentMetadata?.audioModel ?? DEFAULT_AUDIO_MODEL.speech,
  );
  const [audioDuration, setAudioDuration] = useState(
    currentMetadata?.audioDuration ?? 10,
  );
  const [voice, setVoice] = useState(currentMetadata?.voice ?? '');
  // Per-surface curated prompt template the user picked. Tracked
  // independently for image vs video so flipping tabs doesn't clobber the
  // other one's pick. The body is editable in-line and the edited copy is
  // what gets carried to the agent — that's the "optimize the template"
  // affordance the design brief asks for.
  const [imagePromptTemplate, setImagePromptTemplate] =
    useState<PromptTemplatePick | null>(null);
  const [videoPromptTemplate, setVideoPromptTemplate] =
    useState<PromptTemplatePick | null>(null);

  // Seed image/video prompt templates from currentMetadata once
  // `promptTemplates` resolves. We hydrate the template the project was
  // last saved with by id; if the catalog no longer contains it (skill
  // was uninstalled etc.) we leave the slot empty so the picker falls
  // back to its "(none)" option.
  useEffect(() => {
    const saved = currentMetadata?.promptTemplate;
    if (!saved) return;
    const summary = promptTemplates.find((p) => p.id === saved.id);
    if (!summary) return;
    const pick: PromptTemplatePick = { summary, prompt: saved.prompt };
    if (saved.surface === 'image' && !imagePromptTemplate) {
      setImagePromptTemplate(pick);
    } else if (saved.surface === 'video' && !videoPromptTemplate) {
      setVideoPromptTemplate(pick);
    }
    // We only want to run the seed when promptTemplates loads, not on
    // every state change to imagePromptTemplate/videoPromptTemplate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptTemplates]);

  // Design system is meaningful only for the structured/visual surfaces
  // (prototype, deck, template, and the freeform "other" canvas). The
  // media surfaces use prompt templates instead — design tokens don't map
  // onto image/video/audio generations, and the picker just adds noise
  // there. Keep this list explicit so future tabs declare their intent.
  const tabSupportsDesignSystem =
    tab === 'prototype' ||
    tab === 'deck' ||
    tab === 'template' ||
    tab === 'other';
  // Orbit briefings ship their own complete visual language baked into
  // example.html and explicitly opt out of DESIGN.md injection via
  // `od.design_system.requires: false`. Hide the picker only for those
  // Orbit scenario skills; the general prototype creation surface should
  // still honor the user's configured default design system even when a
  // non-Orbit default skill does not require one.
  const tabDefaultSkillForcesNoDs = useMemo(() => {
    const tabSkillId = ((): string | null => {
      if (tab === 'prototype' || tab === 'live-artifact') {
        const list = skills.filter((s) => s.mode === 'prototype');
        return list.find((s) => s.defaultFor.includes('prototype'))?.id
          ?? list[0]?.id ?? null;
      }
      if (tab === 'deck') {
        const list = skills.filter((s) => s.mode === 'deck');
        return list.find((s) => s.defaultFor.includes('deck'))?.id
          ?? list[0]?.id ?? null;
      }
      return null;
    })();
    if (!tabSkillId) return false;
    const s = skills.find((x) => x.id === tabSkillId);
    return s
      ? s.scenario === 'orbit' && s.designSystemRequired === false
      : false;
  }, [tab, skills]);
  const showDesignSystemPicker =
    tabSupportsDesignSystem && !tabDefaultSkillForcesNoDs;

  useEffect(() => {
    if (dsSelectionTouched) return;
    setSelectedDsIds(initialDsSelection);
  }, [dsSelectionTouched, initialDsSelection]);

  // When entering the template tab, snap to the first user-saved template
  // if there is one (and we don't already have a valid pick). The template
  // tab no longer offers a built-in fallback — the entire point is to
  // start from a template *the user* created via Share.
  useEffect(() => {
    if (tab !== 'template') return;
    if (templates.length === 0) {
      setTemplateId(null);
      return;
    }
    if (templateId == null || !templates.some((t) => t.id === templateId)) {
      setTemplateId(templates[0]!.id);
    }
  }, [tab, templates, templateId]);

  // The skill the request still routes through — kept so prototype/deck
  // pick a default-rendered skill (so the agent gets the right SKILL.md
  // body) without requiring the user to choose one explicitly. The
  // resolution order lives in `pickDefaultSkillIdForTab` so it stays
  // testable in isolation.
  const skillIdForTab = useMemo(
    () => pickDefaultSkillIdForTab(tab, skills),
    [tab, skills],
  );

  function updateTabScrollState() {
    const el = tabsRef.current;
    if (!el) return;
    const maxLeft = el.scrollWidth - el.clientWidth;
    setTabScroll({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxLeft - 2,
    });
  }

  function scrollTabs(direction: -1 | 1) {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.65),
      behavior: 'smooth',
    });
  }

  function handleDesignSystemChange(ids: string[]) {
    setDsSelectionTouched(true);
    setSelectedDsIds(ids);
  }

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateTabScrollState();
    const onScroll = () => updateTabScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLButtonElement>('.newproj-tab.active');
    active?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    window.setTimeout(updateTabScrollState, 180);
  }, [tab]);

  // Build the live `FacetSelection` from current state. Memoized so we
  // can pass it to a single change-detecting effect below; downstream
  // panels keep firing into the same shape regardless of which control
  // moved. `JSON.stringify` for the diff is fine here — the metadata
  // object is small (≤20 string/number/bool fields) and stable.
  const currentSelection = useMemo<FacetSelection>(() => {
    const { primary: primaryDs, inspirations } =
      buildDesignSystemCreateSelection(showDesignSystemPicker, selectedDsIds);
    const promptTemplatePick =
      tab === 'image'
        ? imagePromptTemplate
        : tab === 'video'
          ? videoPromptTemplate
          : null;
    const metadata = buildMetadata({
      tab,
      fidelity,
      speakerNotes,
      animations,
      templateId,
      templates,
      imageModel,
      imageAspect,
      imageStyle,
      videoModel,
      videoAspect,
      videoLength,
      audioKind,
      audioModel,
      audioDuration,
      voice,
      inspirationIds: inspirations,
      promptTemplate: promptTemplatePick,
    });
    return {
      skillId: skillIdForTab,
      designSystemId: primaryDs,
      metadata,
    };
  }, [
    showDesignSystemPicker,
    selectedDsIds,
    tab,
    fidelity,
    speakerNotes,
    animations,
    templateId,
    templates,
    imageModel,
    imageAspect,
    imageStyle,
    videoModel,
    videoAspect,
    videoLength,
    audioKind,
    audioModel,
    audioDuration,
    voice,
    imagePromptTemplate,
    videoPromptTemplate,
    skillIdForTab,
  ]);

  // Push the selection up exactly once per change. Skips the very first
  // render so we don't double-write what's already on the project.
  const lastCommittedRef = useRef<string>(JSON.stringify(currentSelection));
  useEffect(() => {
    const serialized = JSON.stringify(currentSelection);
    if (serialized === lastCommittedRef.current) return;
    lastCommittedRef.current = serialized;
    onChange(currentSelection);
  }, [currentSelection, onChange]);

  return (
    <div className="newproj" data-testid="new-project-panel">
      <div className={`newproj-tabs-shell${tabScroll.left ? ' can-left' : ''}${tabScroll.right ? ' can-right' : ''}`}>
        <button
          type="button"
          className={`newproj-tabs-arrow left${tabScroll.left ? '' : ' hidden'}`}
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll project types left"
          tabIndex={tabScroll.left ? 0 : -1}
        >
          <Icon name="chevron-left" size={16} strokeWidth={2} />
        </button>
        <div className="newproj-tabs" role="tablist" ref={tabsRef}>
          {(Object.keys(TAB_LABEL_KEYS) as CreateTab[]).map((entry) => (
            <button
              key={entry}
              role="tab"
              data-testid={`new-project-tab-${entry}`}
              aria-selected={tab === entry}
              className={`newproj-tab ${tab === entry ? 'active' : ''}`}
              onClick={() => setTab(entry)}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`newproj-tabs-arrow right${tabScroll.right ? '' : ' hidden'}`}
          onClick={() => scrollTabs(1)}
          aria-label="Scroll project types right"
          tabIndex={tabScroll.right ? 0 : -1}
        >
          <Icon name="chevron-right" size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="newproj-body">
        <h3 className="newproj-title">
          <span className="newproj-title-text">{titleForTab(tab, t)}</span>
          {tab === 'live-artifact' ? (
            // "Beta" is an internationally adopted brand-style status marker;
            // intentionally not run through t() (consistent with short product
            // status pills that read the same across our supported locales).
            <span className="newproj-title-badge" aria-label="Beta feature">Beta</span>
          ) : null}
        </h3>

        {showDesignSystemPicker ? (
          <DesignSystemPicker
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            selectedIds={selectedDsIds}
            multi={dsMulti}
            onChangeMulti={setDsMulti}
            onChange={handleDesignSystemChange}
            loading={false}
          />
        ) : null}

        {tab === 'image' ? (
          <PromptTemplatePicker
            surface="image"
            templates={promptTemplates}
            value={imagePromptTemplate}
            onChange={setImagePromptTemplate}
          />
        ) : null}

        {tab === 'video' ? (
          <PromptTemplatePicker
            surface="video"
            templates={promptTemplates}
            value={videoPromptTemplate}
            onChange={setVideoPromptTemplate}
          />
        ) : null}

        {tab === 'prototype' || tab === 'live-artifact' ? (
          <FidelityPicker value={fidelity} onChange={setFidelity} />
        ) : null}

        {tab === 'live-artifact' ? (
          <ConnectorsSection
            connectors={connectors}
            loading={connectorsLoading}
            onOpenConnectorsTab={onOpenConnectorsTab}
          />
        ) : null}

        {tab === 'deck' ? (
          <ToggleRow
            label={t('newproj.toggleSpeakerNotes')}
            hint={t('newproj.toggleSpeakerNotesHint')}
            checked={speakerNotes}
            onChange={setSpeakerNotes}
          />
        ) : null}

        {tab === 'template' ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
            />
            <ToggleRow
              label={t('newproj.toggleAnimations')}
              hint={t('newproj.toggleAnimationsHint')}
              checked={animations}
              onChange={setAnimations}
            />
          </>
        ) : null}

        {tab === 'image' ? (
          <MediaProjectOptions
            surface="image"
            imageModel={imageModel}
            imageAspect={imageAspect}
            imageStyle={imageStyle}
            mediaProviders={mediaProviders}
            onImageModel={setImageModel}
            onImageAspect={setImageAspect}
            onImageStyle={setImageStyle}
          />
        ) : null}

        {tab === 'video' ? (
          <MediaProjectOptions
            surface="video"
            videoModel={videoModel}
            videoAspect={videoAspect}
            videoLength={videoLength}
            mediaProviders={mediaProviders}
            onVideoModel={setVideoModel}
            onVideoAspect={setVideoAspect}
            onVideoLength={setVideoLength}
          />
        ) : null}

        {tab === 'audio' ? (
          <MediaProjectOptions
            surface="audio"
            audioKind={audioKind}
            audioModel={audioModel}
            audioDuration={audioDuration}
            voice={voice}
            mediaProviders={mediaProviders}
            onAudioKind={(kind) => {
              setAudioKind(kind);
              setAudioModel(DEFAULT_AUDIO_MODEL[kind]);
            }}
            onAudioModel={setAudioModel}
            onAudioDuration={setAudioDuration}
            onVoice={setVoice}
          />
        ) : null}

      </div>
    </div>
  );
}

function FidelityPicker({
  value,
  onChange,
}: {
  value: 'wireframe' | 'high-fidelity';
  onChange: (v: 'wireframe' | 'high-fidelity') => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.fidelityLabel')}</label>
      <div className="fidelity-grid">
        <FidelityCard
          active={value === 'wireframe'}
          onClick={() => onChange('wireframe')}
          label={t('newproj.fidelityWireframe')}
          variant="wireframe"
        />
        <FidelityCard
          active={value === 'high-fidelity'}
          onClick={() => onChange('high-fidelity')}
          label={t('newproj.fidelityHigh')}
          variant="high-fidelity"
        />
      </div>
    </div>
  );
}

/* ============================================================
   Connectors section (live-artifact only).
   - Lists configured connectors as compact chips so the user can
     see at a glance what data sources this artifact can pull from.
   - When no connector is configured (or the list hasn't loaded yet
     and ended up empty), shows a guidance card that, on click, opens
     the Settings → Connectors surface (the new home of the catalog).
   ============================================================ */
function ConnectorsSection({
  connectors,
  loading,
  onOpenConnectorsTab,
}: {
  connectors?: ConnectorDetail[];
  loading: boolean;
  onOpenConnectorsTab?: () => void;
}) {
  const t = useT();
  const configured = useMemo(
    () => (connectors ?? []).filter((c) => c.status === 'connected'),
    [connectors],
  );
  const hasConfigured = configured.length > 0;

  if (loading && !connectors) {
    return (
      <div className="newproj-section newproj-connectors">
        <label className="newproj-label">{t('newproj.connectorsLabel')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div
      className="newproj-section newproj-connectors"
      data-testid="new-project-connectors"
    >
      <div className="newproj-connectors-head">
        <label className="newproj-label">{t('newproj.connectorsLabel')}</label>
        {hasConfigured ? (
          <button
            type="button"
            className="newproj-connectors-manage"
            onClick={() => onOpenConnectorsTab?.()}
            data-testid="new-project-connectors-manage"
          >
            {t('newproj.connectorsManage')}
          </button>
        ) : null}
      </div>

      {hasConfigured ? (
        <>
          <span className="newproj-connectors-hint">
            {configured.length === 1
              ? t('newproj.connectorsCountOne', { n: configured.length })
              : t('newproj.connectorsCountMany', { n: configured.length })}
            <span aria-hidden> · </span>
            {t('newproj.connectorsHint')}
          </span>
          <ul className="newproj-connectors-list" aria-label={t('newproj.connectorsLabel')}>
            {configured.map((c) => (
              <li
                key={c.id}
                className="newproj-connector-chip"
                title={c.name}
              >
                <span className="newproj-connector-dot" aria-hidden />
                <span className="newproj-connector-name">{c.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <button
          type="button"
          className="newproj-connectors-empty"
          onClick={() => onOpenConnectorsTab?.()}
          data-testid="new-project-connectors-empty"
          aria-label={t('newproj.connectorsEmptyCta')}
        >
          <span className="newproj-connectors-empty-icon" aria-hidden>
            <Icon name="link" size={14} />
          </span>
          <span className="newproj-connectors-empty-text">
            <span className="newproj-connectors-empty-title">
              {t('newproj.connectorsEmptyTitle')}
            </span>
            <span className="newproj-connectors-empty-body">
              {t('newproj.connectorsEmptyBody')}
            </span>
            <span className="newproj-connectors-empty-cta">
              {t('newproj.connectorsEmptyCta')}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function FidelityCard({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant: 'wireframe' | 'high-fidelity';
}) {
  return (
    <button
      type="button"
      className={`fidelity-card${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`fidelity-thumb fidelity-thumb-${variant}`} aria-hidden>
        {variant === 'wireframe' ? <WireframeArt /> : <HighFidelityArt />}
      </span>
      <span className="fidelity-label">{label}</span>
    </button>
  );
}

function WireframeArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="46" height="6" rx="2" fill="#d8d4cb" />
      <rect x="6" y="20" width="34" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="28" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="36" width="30" height="4" rx="2" fill="#ebe8e1" />
      <circle cx="22" cy="56" r="6" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="64" y="8" width="50" height="54" rx="3" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="22" width="32" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="30" width="38" height="4" rx="2" fill="#ebe8e1" />
    </svg>
  );
}

function HighFidelityArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="34" height="6" rx="2" fill="#1a1916" />
      <rect x="6" y="20" width="46" height="4" rx="2" fill="#74716b" />
      <rect x="6" y="28" width="42" height="4" rx="2" fill="#b3b0a8" />
      <rect x="6" y="40" width="22" height="9" rx="2" fill="#c96442" />
      <rect x="64" y="8" width="50" height="54" rx="4" fill="#fbeee5" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#c96442" />
      <rect x="70" y="22" width="32" height="3" rx="1.5" fill="#74716b" />
      <rect x="70" y="29" width="36" height="3" rx="1.5" fill="#b3b0a8" />
      <rect x="70" y="36" width="20" height="6" rx="2" fill="#c96442" />
    </svg>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <div className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {hint ? <span className="toggle-row-hint">{hint}</span> : null}
      </div>
      <span className="toggle-row-switch" aria-hidden />
    </button>
  );
}

function TemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.templateLabel')}</label>
      {templates.length === 0 ? (
        <div className="template-howto">
          <span className="template-howto-title">
            {t('newproj.noTemplatesTitle')}
          </span>
          <span className="template-howto-body">
            {t('newproj.noTemplatesBody')}
          </span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((tpl) => {
            const fallbackDesc = `${t('newproj.savedTemplate')} · ${tpl.files.length} ${
              tpl.files.length === 1
                ? t('newproj.fileSingular')
                : t('newproj.filePlural')
            }`;
            return (
              <TemplateOption
                key={tpl.id}
                active={value === tpl.id}
                onClick={() => onChange(tpl.id)}
                name={tpl.name}
                description={tpl.description ?? fallbackDesc}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Prompt template picker — for the image/video tabs only.
   - Trigger card (mirrors the design-system trigger) opens a popover
     with a search field and a thumbnail-card list filtered by surface.
   - When a template is picked we lazily fetch the full prompt body via
     fetchPromptTemplate(...) and drop it into a textarea so the user
     can tune ("optimize") the wording before clicking Create.
   - The (possibly edited) body lands in metadata.promptTemplate.prompt
     and becomes part of the system prompt — the agent treats it as a
     stylistic + structural reference for the generation request.
   ============================================================ */
function PromptTemplatePicker({
  surface,
  templates,
  value,
  onChange,
}: {
  surface: 'image' | 'video';
  templates: PromptTemplateSummary[];
  value: PromptTemplatePick | null;
  onChange: (next: PromptTemplatePick | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Last template we tried to pick that failed — kept so the inline
  // banner can offer a one-click retry without making the user re-find
  // the card in the popover (which auto-closed on success). Cleared as
  // soon as a pick succeeds or the user picks a different template.
  const [lastFailedPick, setLastFailedPick] =
    useState<PromptTemplateSummary | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const surfaceScoped = useMemo(
    () => templates.filter((tpl) => tpl.surface === surface),
    [templates, surface],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return surfaceScoped;
    return surfaceScoped.filter((tpl) => {
      return (
        tpl.title.toLowerCase().includes(q) ||
        tpl.summary.toLowerCase().includes(q) ||
        (tpl.category || '').toLowerCase().includes(q) ||
        (tpl.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [surfaceScoped, query]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function pickTemplate(summary: PromptTemplateSummary) {
    setLoadingId(summary.id);
    setError(null);
    try {
      const detail = await fetchPromptTemplate(summary.surface, summary.id);
      if (!detail) {
        setError(t('promptTemplates.fetchError'));
        setLastFailedPick(summary);
        return;
      }
      onChange({ summary, prompt: detail.prompt });
      setLastFailedPick(null);
      setOpen(false);
      setQuery('');
    } catch {
      // fetchPromptTemplate already swallows errors and returns null in
      // the happy path; this catch is a defensive net for unexpected
      // throws so the inline banner still surfaces and the user can
      // retry instead of being stuck on a permanent loading spinner.
      setError(t('promptTemplates.fetchError'));
      setLastFailedPick(summary);
    } finally {
      setLoadingId(null);
    }
  }

  function clear() {
    onChange(null);
    setLastFailedPick(null);
    setError(null);
    setOpen(false);
    setQuery('');
  }

  const triggerTitle = value?.summary.title ?? t('newproj.promptTemplateNoneTitle');
  const triggerSub = value
    ? value.summary.category || value.summary.summary || t('newproj.promptTemplateRefSub')
    : t('newproj.promptTemplateNoneSub');

  return (
    <div className="newproj-section ds-picker prompt-template-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.promptTemplateLabel')}</label>
      <button
        type="button"
        data-testid="prompt-template-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${value ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <PromptTemplateAvatar summary={value?.summary ?? null} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">{triggerTitle}</span>
          <span className="ds-picker-sub">{triggerSub}</span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div className="ds-picker-popover" role="listbox">
          <div className="ds-picker-head">
            <input
              ref={searchRef}
              data-testid="prompt-template-search"
              className="ds-picker-search"
              placeholder={t('newproj.promptTemplateSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ds-picker-list">
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={`ds-picker-item${value === null ? ' active' : ''}`}
              onClick={clear}
            >
              <span className="ds-picker-item-avatar">
                <NoneAvatar />
              </span>
              <span className="ds-picker-item-text">
                <span className="ds-picker-item-title">
                  {t('newproj.promptTemplateNoneTitle')}
                </span>
                <span className="ds-picker-item-sub">
                  {t('newproj.promptTemplateNoneSub')}
                </span>
              </span>
            </button>
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {surfaceScoped.length === 0
                  ? t('newproj.promptTemplateEmpty')
                  : t('promptTemplates.emptyNoMatch')}
              </div>
            ) : (
              filtered.map((tpl) => {
                const active = value?.summary.id === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`ds-picker-item${active ? ' active' : ''}`}
                    onClick={() => void pickTemplate(tpl)}
                    disabled={loadingId === tpl.id}
                  >
                    <span className="ds-picker-item-avatar">
                      <PromptTemplateAvatar summary={tpl} />
                    </span>
                    <span className="ds-picker-item-text">
                      <span className="ds-picker-item-title">
                        {tpl.title}
                        {loadingId === tpl.id ? (
                          <span className="ds-picker-item-badge">
                            {t('common.loading')}
                          </span>
                        ) : null}
                      </span>
                      <span className="ds-picker-item-sub">
                        {tpl.summary || tpl.category}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          className="prompt-template-error"
          role="alert"
          data-testid="prompt-template-error"
        >
          <span className="prompt-template-error-msg">{error}</span>
          {lastFailedPick ? (
            <button
              type="button"
              className="ghost prompt-template-error-retry"
              data-testid="prompt-template-retry"
              onClick={() => void pickTemplate(lastFailedPick)}
              disabled={loadingId === lastFailedPick.id}
            >
              {loadingId === lastFailedPick.id
                ? t('common.loading')
                : t('promptTemplates.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {value ? (
        <div className="prompt-template-edit">
          <div className="prompt-template-edit-head">
            <span className="prompt-template-edit-label">
              {t('newproj.promptTemplateBodyLabel')}
            </span>
            <span className="prompt-template-edit-hint">
              {t('newproj.promptTemplateOptimizeHint')}
            </span>
          </div>
          <textarea
            data-testid="prompt-template-body"
            className="prompt-template-edit-textarea"
            value={value.prompt}
            rows={6}
            onChange={(e) =>
              onChange({ summary: value.summary, prompt: e.target.value })
            }
          />
          {value.prompt.trim().length === 0 ? (
            <div
              className="prompt-template-edit-empty"
              data-testid="prompt-template-empty-hint"
            >
              {t('newproj.promptTemplateBodyEmpty')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PromptTemplateAvatar({
  summary,
}: {
  summary: PromptTemplateSummary | null;
}) {
  if (!summary) return <NoneAvatar />;
  if (summary.previewImageUrl) {
    return (
      <span className="ds-avatar prompt-template-avatar" aria-hidden>
        <img
          src={summary.previewImageUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span className="ds-avatar prompt-template-avatar fallback" aria-hidden>
      <Icon name={summary.surface === 'video' ? 'play' : 'image'} size={14} />
    </span>
  );
}

function TemplateOption({
  active,
  onClick,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  description: string;
}) {
  return (
    <button
      type="button"
      className={`template-option${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
      <span className="template-option-text">
        <span className="template-option-name">{name}</span>
        <span className="template-option-desc">{description}</span>
      </span>
    </button>
  );
}

/* ============================================================
   Design system picker — custom popover (replaces native <select>).
   - Single-select by default. Toggle in the popover header switches to
     multi-select, which lets users blend up to a few inspirations
     (first pick is the primary; the rest go into metadata).
   - Trigger card mirrors the claude.ai/design treatment: a tiny brand
     swatch strip + title + "Default" subtitle + chevron.
   ============================================================ */
function DesignSystemPicker({
  designSystems,
  defaultDesignSystemId,
  selectedIds,
  multi,
  onChange,
  onChangeMulti,
  loading,
}: {
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  selectedIds: string[];
  multi: boolean;
  onChange: (ids: string[]) => void;
  onChangeMulti: (v: boolean) => void;
  loading: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, DesignSystemSummary>();
    for (const d of designSystems) map.set(d.id, d);
    return map;
  }, [designSystems]);

  // Sort: selected first (in pick order), then default DS, then alpha
  // by category then title. Keeps the popover scannable while honoring
  // the user's existing picks.
  const ordered = useMemo(() => {
    const picked = selectedIds
      .map((id) => byId.get(id))
      .filter((d): d is DesignSystemSummary => Boolean(d));
    const pickedSet = new Set(picked.map((d) => d.id));
    const rest = designSystems
      .filter((d) => !pickedSet.has(d.id))
      .sort((a, b) => {
        if (a.id === defaultDesignSystemId) return -1;
        if (b.id === defaultDesignSystemId) return 1;
        const ca = a.category || 'Other';
        const cb = b.category || 'Other';
        if (ca !== cb) return ca.localeCompare(cb);
        return a.title.localeCompare(b.title);
      });
    return [...picked, ...rest];
  }, [designSystems, byId, selectedIds, defaultDesignSystemId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((d) => {
      return (
        d.title.toLowerCase().includes(q) ||
        (d.summary || '').toLowerCase().includes(q) ||
        (d.category || '').toLowerCase().includes(q)
      );
    });
  }, [ordered, query]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle (StrictMode also
    // double-invokes the effect, which can race the same event).
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(id: string) {
    if (multi) {
      // Multi-select: tapping toggles membership; the *first* id in the
      // array is treated as the primary across the rest of the app.
      const has = selectedIds.includes(id);
      if (has) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    } else {
      onChange([id]);
      setOpen(false);
    }
  }

  function clearAll() {
    onChange([]);
    if (!multi) setOpen(false);
  }

  const primaryId = selectedIds[0] ?? null;
  const primary = primaryId ? byId.get(primaryId) ?? null : null;
  const extraCount = Math.max(0, selectedIds.length - 1);
  const isDefault = !!primary && primary.id === defaultDesignSystemId;

  if (loading && designSystems.length === 0) {
    return (
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.designSystem')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div className="newproj-section ds-picker" data-testid="design-system-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.designSystem')}</label>
      <button
        type="button"
        data-testid="design-system-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <DesignSystemAvatar system={primary} extraCount={extraCount} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? primary.title : t('newproj.dsNoneFreeform')}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
          <span className="ds-picker-sub">
            {primary
              ? isDefault
                ? t('common.default')
                : primary.category || t('newproj.dsCategoryFallback')
              : t('newproj.dsNoneSubtitleEmpty')}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div className="ds-picker-popover" role="listbox">
          <div className="ds-picker-head">
            <input
              ref={searchRef}
              data-testid="design-system-search"
              className="ds-picker-search"
              placeholder={t('newproj.dsSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className="ds-picker-mode"
              role="tablist"
              aria-label={t('newproj.dsModeAria')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={!multi}
                className={`ds-picker-mode-btn${!multi ? ' active' : ''}`}
                onClick={() => {
                  onChangeMulti(false);
                  if (selectedIds.length > 1) onChange(selectedIds.slice(0, 1));
                }}
              >
                {t('newproj.dsModeSingle')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={multi}
                className={`ds-picker-mode-btn${multi ? ' active' : ''}`}
                onClick={() => onChangeMulti(true)}
              >
                {t('newproj.dsModeMulti')}
              </button>
            </div>
          </div>
          <div className="ds-picker-list">
            <DsPickerItem
              active={selectedIds.length === 0}
              multi={multi}
              onClick={clearAll}
              avatar={<NoneAvatar />}
              title={t('newproj.dsNoneTitle')}
              subtitle={t('newproj.dsNoneSub')}
            />
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {t('newproj.dsEmpty', { query })}
              </div>
            ) : (
              filtered.map((d) => {
                const active = selectedIds.includes(d.id);
                const order = active ? selectedIds.indexOf(d.id) : -1;
                return (
                  <DsPickerItem
                    key={d.id}
                    active={active}
                    multi={multi}
                    order={order}
                    onClick={() => toggle(d.id)}
                    avatar={<DesignSystemAvatar system={d} />}
                    title={d.title}
                    badge={
                      d.id === defaultDesignSystemId
                        ? t('newproj.dsBadgeDefault')
                        : undefined
                    }
                    subtitle={d.summary || d.category || ''}
                  />
                );
              })
            )}
          </div>
          {multi && selectedIds.length > 1 ? (
            <div className="ds-picker-foot">
              <span className="ds-picker-foot-text">
                <strong>{primary?.title ?? t('newproj.dsPrimaryFallback')}</strong>{' '}
                {extraCount === 1
                  ? t('newproj.dsFootSingular')
                  : t('newproj.dsFootPlural')}
              </span>
              <button
                type="button"
                className="ds-picker-clear"
                onClick={clearAll}
              >
                {t('newproj.dsFootClear')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DsPickerItem({
  active,
  multi,
  order,
  onClick,
  avatar,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  multi: boolean;
  order?: number;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`ds-picker-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="ds-picker-item-avatar">{avatar}</span>
      <span className="ds-picker-item-text">
        <span className="ds-picker-item-title">
          {title}
          {badge ? <span className="ds-picker-item-badge">{badge}</span> : null}
        </span>
        <span className="ds-picker-item-sub">{subtitle}</span>
      </span>
      <span
        className={`ds-picker-mark ${multi ? 'check' : 'radio'}${active ? ' active' : ''}`}
        aria-hidden
      >
        {multi ? (
          active ? (order != null && order >= 0 ? order + 1 : '✓') : ''
        ) : null}
      </span>
    </button>
  );
}

function DesignSystemAvatar({
  system,
  extraCount = 0,
}: {
  system: DesignSystemSummary | null;
  extraCount?: number;
}) {
  if (!system) return <NoneAvatar />;
  const swatches = system.swatches && system.swatches.length > 0
    ? system.swatches.slice(0, 4)
    : fallbackSwatches(system.title);
  return (
    <span className="ds-avatar" aria-hidden>
      <span className="ds-avatar-grid">
        {swatches.map((c, i) => (
          <span key={i} className="ds-avatar-cell" style={{ background: c }} />
        ))}
      </span>
      {extraCount > 0 ? (
        <span className="ds-avatar-stack">+{extraCount}</span>
      ) : null}
    </span>
  );
}

function NoneAvatar() {
  return (
    <span className="ds-avatar ds-avatar-none" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  );
}

// Deterministic fallback swatches for design systems whose DESIGN.md doesn't
// expose its tokens via the bold-and-hex format. Keeps the avatar visually
// distinct per-system without extra metadata fetches.
function fallbackSwatches(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const base = h % 360;
  return [
    `hsl(${base}, 18%, 96%)`,
    `hsl(${(base + 90) % 360}, 22%, 78%)`,
    `hsl(${(base + 180) % 360}, 30%, 32%)`,
    `hsl(${(base + 30) % 360}, 70%, 52%)`,
  ];
}

function MediaProjectOptions(props:
  | {
      surface: 'image';
      imageModel: string;
      imageAspect: MediaAspect;
      imageStyle: string;
      mediaProviders?: Record<string, MediaProviderCredentials>;
      onImageModel: (value: string) => void;
      onImageAspect: (value: MediaAspect) => void;
      onImageStyle: (value: string) => void;
    }
  | {
      surface: 'video';
      videoModel: string;
      videoAspect: MediaAspect;
      videoLength: number;
      mediaProviders?: Record<string, MediaProviderCredentials>;
      onVideoModel: (value: string) => void;
      onVideoAspect: (value: MediaAspect) => void;
      onVideoLength: (value: number) => void;
    }
  | {
      surface: 'audio';
      audioKind: AudioKind;
      audioModel: string;
      audioDuration: number;
      voice: string;
      mediaProviders?: Record<string, MediaProviderCredentials>;
      onAudioKind: (value: AudioKind) => void;
      onAudioModel: (value: string) => void;
      onAudioDuration: (value: number) => void;
      onVoice: (value: string) => void;
    }
) {
  const t = useT();

  if (props.surface === 'image') {
    return (
      <div className="newproj-media-options">
        <MediaModelCards
          label={t('newproj.modelLabel')}
          models={supportedModels('image', IMAGE_MODELS)}
          mediaProviders={props.mediaProviders}
          value={props.imageModel}
          onChange={props.onImageModel}
        />
        <AspectCards
          label={t('newproj.aspectLabel')}
          value={props.imageAspect}
          onChange={props.onImageAspect}
        />
        <label className="newproj-label">
          <span>{t('newproj.imageStyleLabel')}</span>
          <input
            value={props.imageStyle}
            placeholder={t('newproj.imageStylePlaceholder')}
            onChange={(e) => props.onImageStyle(e.target.value)}
          />
        </label>
      </div>
    );
  }

  if (props.surface === 'video') {
    return (
      <div className="newproj-media-options">
        <MediaModelCards
          label={t('newproj.modelLabel')}
          models={supportedModels('video', VIDEO_MODELS)}
          mediaProviders={props.mediaProviders}
          value={props.videoModel}
          onChange={props.onVideoModel}
        />
        <AspectCards
          label={t('newproj.aspectLabel')}
          value={props.videoAspect}
          onChange={props.onVideoAspect}
        />
        <label className="newproj-label">
          <span>{t('newproj.videoLengthLabel')}</span>
          <select value={props.videoLength} onChange={(e) => props.onVideoLength(Number(e.target.value))}>
            {VIDEO_LENGTHS_SEC.map((sec) => (
              <option key={sec} value={sec}>{t('newproj.videoLengthSeconds', { n: sec })}</option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  const models = supportedModels('audio', AUDIO_MODELS_BY_KIND[props.audioKind]);
  return (
    <div className="newproj-media-options">
      <OptionCards
        label={t('newproj.audioKindLabel')}
        options={[
          { value: 'speech' as const, title: t('newproj.audioKindSpeech') },
        ]}
        value={props.audioKind}
        onChange={props.onAudioKind}
      />
      <MediaModelCards
        label={t('newproj.modelLabel')}
        models={models}
        mediaProviders={props.mediaProviders}
        value={props.audioModel}
        onChange={props.onAudioModel}
      />
      <label className="newproj-label">
        <span>{t('newproj.audioDurationLabel')}</span>
        <select value={props.audioDuration} onChange={(e) => props.onAudioDuration(Number(e.target.value))}>
          {AUDIO_DURATIONS_SEC.map((sec) => (
            <option key={sec} value={sec}>{t('newproj.audioDurationSeconds', { n: sec })}</option>
          ))}
        </select>
      </label>
      {props.audioKind === 'speech' ? (
        <label className="newproj-label">
          <span>{t('newproj.voiceLabel')}</span>
          <input
            value={props.voice}
            placeholder={t('newproj.voicePlaceholder')}
            onChange={(e) => props.onVoice(e.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}

export function supportedModels(surface: 'image' | 'video' | 'audio', models: MediaModel[]): MediaModel[] {
  const supportedProviders: Record<'image' | 'video' | 'audio', Set<string>> = {
    image: new Set(['openai', 'volcengine', 'grok', 'nanobanana']),
    video: new Set(['volcengine', 'hyperframes', 'grok']),
    audio: new Set(['minimax', 'fishaudio']),
  };
  return models.filter((model) => {
    const provider = findProvider(model.provider);
    return provider?.integrated === true && supportedProviders[surface].has(model.provider);
  });
}

function MediaModelCards({
  label,
  models,
  mediaProviders,
  value,
  onChange,
}: {
  label: string;
  models: MediaModel[];
  mediaProviders?: Record<string, MediaProviderCredentials>;
  value: string;
  onChange: (value: string) => void;
}) {
  const groups: Array<{
    providerId: string;
    providerLabel: string;
    status: 'configured' | 'integrated' | 'unsupported';
    models: MediaModel[];
  }> = [];
  for (const model of models) {
    const provider = findProvider(model.provider);
    const providerId = provider?.id ?? model.provider;
    const entry = mediaProviders?.[providerId];
    const configured = provider?.credentialsRequired === false
      || isStoredMediaProviderEntryPresent(entry);
    let group = groups.find((g) => g.providerId === providerId);
    if (!group) {
      group = {
        providerId,
        providerLabel: provider?.label ?? model.provider,
        status: configured
          ? 'configured'
          : provider?.integrated
            ? 'integrated'
            : 'unsupported',
        models: [],
      };
      groups.push(group);
    }
    group.models.push(model);
  }

  return (
    <div className="newproj-media-field">
      <div className="newproj-label">{label}</div>
      <div className="newproj-model-groups">
        {groups.map((group) => (
          <div className="newproj-model-group" key={group.providerId}>
            <div className="newproj-provider-row">
              <span>{group.providerLabel}</span>
              <span className={`newproj-provider-badge ${group.status}`}>
                {group.status === 'configured'
                  ? 'Configured'
                  : group.status === 'integrated'
                    ? 'Integrated'
                    : 'Unsupported'}
              </span>
            </div>
            <div className="newproj-model-grid">
              {group.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`newproj-card newproj-model-card${value === model.id ? ' active' : ''}`}
                  onClick={() => onChange(model.id)}
                  aria-pressed={value === model.id}
                >
                  <span className="newproj-model-name">{model.label}</span>
                  <span className="newproj-model-hint">{model.hint}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AspectCards({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MediaAspect;
  onChange: (value: MediaAspect) => void;
}) {
  const labels: Record<MediaAspect, string> = {
    '1:1': 'Square',
    '16:9': 'Landscape',
    '9:16': 'Portrait',
    '4:3': 'Wide',
    '3:4': 'Tall',
  };
  return (
    <div className="newproj-media-field">
      <div className="newproj-label">{label}</div>
      <div className="newproj-option-grid aspect-grid">
        {MEDIA_ASPECTS.map((aspect) => (
          <button
            key={aspect}
            type="button"
            className={`newproj-card newproj-option-card${value === aspect ? ' active' : ''}`}
            onClick={() => onChange(aspect)}
            aria-pressed={value === aspect}
          >
            <span className={`aspect-glyph aspect-${aspect.replace(':', '-')}`} aria-hidden />
            <span className="aspect-copy">
              <strong>{labels[aspect]}</strong>
              <small>{aspect}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function OptionCards<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; title: string; hint?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="newproj-media-field">
      <div className="newproj-label">{label}</div>
      <div className="newproj-option-grid compact">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={`newproj-card newproj-option-card${value === option.value ? ' active' : ''}`}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
          >
            <span>{option.title}</span>
            {option.hint ? <small>{option.hint}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function buildMetadata(input: {
  tab: CreateTab;
  fidelity: 'wireframe' | 'high-fidelity';
  speakerNotes: boolean;
  animations: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
  imageModel: string;
  imageAspect: MediaAspect;
  imageStyle: string;
  videoModel: string;
  videoAspect: MediaAspect;
  videoLength: number;
  audioKind: AudioKind;
  audioModel: string;
  audioDuration: number;
  voice: string;
  inspirationIds: string[];
  promptTemplate: PromptTemplatePick | null;
}): ProjectMetadata {
  const kind: ProjectKind = input.tab === 'live-artifact' ? 'prototype' : input.tab;
  const inspirations = input.inspirationIds.length > 0
    ? { inspirationDesignSystemIds: input.inspirationIds }
    : {};
  if (input.tab === 'prototype' || input.tab === 'live-artifact') {
    return {
      kind,
      fidelity: input.fidelity,
      ...(input.tab === 'live-artifact' ? { intent: 'live-artifact' as const } : {}),
      ...inspirations,
    };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes, ...inspirations };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, animations: input.animations, ...inspirations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      animations: input.animations,
      templateId: input.templateId,
      templateLabel: tpl?.name ?? 'Saved template',
      ...inspirations,
    };
  }
  if (input.tab === 'image') {
    return {
      kind,
      imageModel: input.imageModel,
      imageAspect: input.imageAspect,
      imageStyle: input.imageStyle.trim() || undefined,
      ...buildPromptTemplateMetadata(input.promptTemplate),
      ...inspirations,
    };
  }
  if (input.tab === 'video') {
    return {
      kind,
      videoModel: input.videoModel,
      videoAspect: input.videoAspect,
      videoLength: input.videoLength,
      ...buildPromptTemplateMetadata(input.promptTemplate),
      ...inspirations,
    };
  }
  if (input.tab === 'audio') {
    return {
      kind,
      audioKind: input.audioKind,
      audioModel: input.audioModel,
      audioDuration: input.audioDuration,
      voice: input.voice.trim() || undefined,
      ...inspirations,
    };
  }
  return { kind: 'other', ...inspirations };
}

function buildPromptTemplateMetadata(
  pick: PromptTemplatePick | null,
): { promptTemplate?: ProjectMetadata['promptTemplate'] } {
  if (!pick) return {};
  const trimmed = pick.prompt.trim();
  if (trimmed.length === 0) return {};
  const { summary } = pick;
  return {
    promptTemplate: {
      id: summary.id,
      surface: summary.surface,
      title: summary.title,
      prompt: trimmed,
      summary: summary.summary || undefined,
      category: summary.category || undefined,
      tags: summary.tags && summary.tags.length > 0 ? summary.tags : undefined,
      model: summary.model,
      aspect: summary.aspect,
      source: summary.source
        ? {
            repo: summary.source.repo,
            license: summary.source.license,
            author: summary.source.author,
            url: summary.source.url,
          }
        : undefined,
    },
  };
}

function titleForTab(tab: CreateTab, t: TranslateFn): string {
  switch (tab) {
    case 'prototype':
      return t('newproj.titlePrototype');
    case 'live-artifact':
      return t('newproj.titleLiveArtifact');
    case 'deck':
      return t('newproj.titleDeck');
    case 'template':
      return t('newproj.titleTemplate');
    case 'image':
      return t('newproj.titleImage');
    case 'video':
      return t('newproj.titleVideo');
    case 'audio':
      return t('newproj.titleAudio');
    case 'other':
      return t('newproj.titleOther');
  }
}

function autoName(tab: CreateTab, t: TranslateFn): string {
  const stamp = new Date().toLocaleDateString();
  return `${t(TAB_LABEL_KEYS[tab])} · ${stamp}`;
}

/**
 * Pick which tab the popover should land on, given what's already
 * persisted on the project. The tab enum has eight values; only seven
 * are 1:1 with skill `mode` (the `live-artifact` tab is a UI-only
 * variant of `prototype` flagged by `metadata.intent === 'live-artifact'`,
 * and `other` means "no skill"). We respect that mapping when
 * hydrating, so reopening a project drops the user back into the same
 * tab they last picked.
 */
function deriveTabFromSelection(
  skillId: string | null,
  metadata: ProjectMetadata | undefined,
  skills: SkillSummary[],
): CreateTab {
  if (!skillId) return 'other';
  if (metadata?.intent === 'live-artifact') return 'live-artifact';
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return 'prototype';
  switch (skill.mode) {
    case 'prototype':
      return 'prototype';
    case 'deck':
      return 'deck';
    case 'template':
      return 'template';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'design-system':
      // The new contract has 'design-system' as a mode but the legacy
      // form's tab set doesn't — fold it into "other" so the user still
      // sees the freeform surface and can pick something else.
      return 'other';
    default:
      return 'prototype';
  }
}
