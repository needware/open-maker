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
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConnectorDetail, ImportFolderResponse } from '@open-design/contracts';

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
  ProjectPlatform,
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
import { Toast } from './Toast';

/**
 * Best-effort flattening of the `details` field that the
 * pickAndImport main-process handler attaches when the daemon returned
 * a structured error envelope (PR #974 round-4 mrcfps). Daemon errors
 * carry `error.message` and sometimes nested `error.details.reason`;
 * we surface the most operator-actionable string we can find without
 * over-coupling to any particular error code.
 */
function formatPickAndImportErrorDetails(details: unknown): string | undefined {
  if (typeof details === 'string' && details.length > 0) return details;
  if (details == null || typeof details !== 'object') return undefined;
  const record = details as Record<string, unknown>;
  const error = record.error;
  if (error != null && typeof error === 'object') {
    const errRecord = error as Record<string, unknown>;
    const message = errRecord.message;
    const nestedDetails = errRecord.details;
    if (typeof message === 'string' && message.length > 0) {
      if (nestedDetails != null && typeof nestedDetails === 'object') {
        const nestedReason = (nestedDetails as Record<string, unknown>).reason;
        if (typeof nestedReason === 'string' && nestedReason.length > 0) {
          return `${message} (${nestedReason})`;
        }
      }
      return message;
    }
  }
  return undefined;
}

// Snapshot of a curated prompt template, captured at New Project time and
// folded into ProjectMetadata.promptTemplate. The user may have edited the
// prompt body before clicking Create — that edited copy lives here.
type PromptTemplatePick = {
  summary: PromptTemplateSummary;
  prompt: string;
};

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// Target-platforms picker domain. Ported from the pre-RFC NewProjectPanel so
// the facet popover can drive `metadata.platform` / `metadata.platformTargets`
// alongside the existing per-facet controls. `auto` is a daemon-side
// "decide for me" value; the panel surfaces only concrete targets.
type NewProjectPlatform = Exclude<ProjectPlatform, 'auto'>;

const DESIGN_PLATFORMS: Array<{
  value: NewProjectPlatform;
  labelKey: keyof Dict;
  hintKey: keyof Dict;
}> = [
  {
    value: 'responsive',
    labelKey: 'newproj.platform.responsive.label',
    hintKey: 'newproj.platform.responsive.hint',
  },
  {
    value: 'web-desktop',
    labelKey: 'newproj.platform.webDesktop.label',
    hintKey: 'newproj.platform.webDesktop.hint',
  },
  {
    value: 'mobile-ios',
    labelKey: 'newproj.platform.mobileIos.label',
    hintKey: 'newproj.platform.mobileIos.hint',
  },
  {
    value: 'mobile-android',
    labelKey: 'newproj.platform.mobileAndroid.label',
    hintKey: 'newproj.platform.mobileAndroid.hint',
  },
  {
    value: 'tablet',
    labelKey: 'newproj.platform.tablet.label',
    hintKey: 'newproj.platform.tablet.hint',
  },
  {
    value: 'desktop-app',
    labelKey: 'newproj.platform.desktopApp.label',
    hintKey: 'newproj.platform.desktopApp.hint',
  },
];

function normalizeSelectedPlatforms(
  platforms: NewProjectPlatform[],
): NewProjectPlatform[] {
  const seen = new Set<NewProjectPlatform>();
  for (const platform of platforms) {
    if (DESIGN_PLATFORMS.some((option) => option.value === platform)) {
      seen.add(platform);
    }
  }
  return seen.size > 0 ? [...seen] : ['responsive'];
}

function platformTargetsSupportOsWidgets(
  platforms: ProjectPlatform[] | NewProjectPlatform[],
): boolean {
  return platforms.some(
    (platform) =>
      platform === 'mobile-ios' ||
      platform === 'mobile-android' ||
      platform === 'tablet',
  );
}

function platformTargetsFor(
  platforms: NewProjectPlatform[],
): ProjectPlatform[] {
  const targets = new Set<ProjectPlatform>();
  for (const platform of platforms) {
    switch (platform) {
      case 'responsive':
        targets.add('responsive');
        break;
      case 'web-desktop':
        targets.add('web-desktop');
        break;
      case 'mobile-ios':
        targets.add('mobile-ios');
        break;
      case 'mobile-android':
        targets.add('mobile-android');
        break;
      case 'tablet':
        targets.add('tablet');
        break;
      case 'desktop-app':
        targets.add('desktop-app');
        break;
      default: {
        const exhaustive: never = platform;
        targets.add(exhaustive);
      }
    }
  }
  return targets.size > 0 ? [...targets] : ['responsive'];
}

// Best-effort hydration of `platformTargets` state from existing project
// metadata. Reads `platformTargets` first (the precise field set), then
// falls back to the singular `platform`. `auto` is treated as "no
// explicit pick" and resolves to the default `['responsive']`.
function hydratePlatformTargets(
  metadata: ProjectMetadata | undefined,
): NewProjectPlatform[] {
  const targets = metadata?.platformTargets;
  if (targets && targets.length > 0) {
    const filtered = targets.filter(
      (p): p is NewProjectPlatform => p !== 'auto',
    );
    if (filtered.length > 0) return normalizeSelectedPlatforms(filtered);
  }
  const primary = metadata?.platform;
  if (primary && primary !== 'auto') {
    return normalizeSelectedPlatforms([primary]);
  }
  return ['responsive'];
}

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
  'platform',
  'platformTargets',
  'includeLandingPage',
  'includeOsWidgets',
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
  /** Optional. When omitted (e.g. the FacetSetupPopover surface that
   *  edits an existing project's parameters), TemplatePicker hides its
   *  delete affordance — template management lives in Settings, not in
   *  the popover. */
  onDeleteTemplate?: (id: string) => Promise<boolean>;
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

// Tab labels reuse the existing `newproj.surface*` keys for the three
// media tabs ("Image" / "Video" / "Audio") so we don't need to fan out
// a new `newproj.tab{Image,Video,Audio}` triple into every locale file.
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
  onDeleteTemplate,
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
  // Target platforms — multi-select. `auto` is filtered out at hydration
  // time so the picker always shows concrete picks. Empty arrays are
  // normalized to `['responsive']` by normalizeSelectedPlatforms.
  const [platformTargets, setPlatformTargets] = useState<NewProjectPlatform[]>(
    () => hydratePlatformTargets(currentMetadata),
  );
  const [includeLandingPage, setIncludeLandingPage] = useState(
    currentMetadata?.includeLandingPage ?? false,
  );
  const [includeOsWidgets, setIncludeOsWidgets] = useState(
    currentMetadata?.includeOsWidgets ?? false,
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

  // Picking an image/video prompt template can also propose a default
  // model + aspect — apply them when the template's model is one of the
  // installed providers, otherwise leave the existing pick alone so the
  // user can switch templates without losing their selected model.
  function handleImagePromptTemplate(pick: PromptTemplatePick | null) {
    setImagePromptTemplate(pick);
    const m = pick?.summary.model;
    if (m && IMAGE_MODELS.some((x) => x.id === m)) setImageModel(m);
    const a = pick?.summary.aspect;
    if (a && (MEDIA_ASPECTS as readonly string[]).includes(a)) {
      setImageAspect(a as MediaAspect);
    }
  }
  function handleVideoPromptTemplate(pick: PromptTemplatePick | null) {
    setVideoPromptTemplate(pick);
    const m = pick?.summary.model;
    if (m && VIDEO_MODELS.some((x) => x.id === m)) {
      setVideoModel(m);
    }
    const a = pick?.summary.aspect;
    if (a && (MEDIA_ASPECTS as readonly string[]).includes(a)) {
      setVideoAspect(a as MediaAspect);
    }
  }
  // Thin wrapper over setVideoModel. The original (PR #1304) also flipped
  // a `videoModelTouched` flag so a downstream effect could auto-default
  // the model on tab/skill changes; that effect didn't survive the
  // FacetParametersPanel rewrite, so until it's re-introduced the touched
  // tracking is dead and we just forward straight to the setter.
  function handleVideoModel(id: string) {
    setVideoModel(id);
  }

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
  // Target platforms + Companion surfaces apply to the same four
  // structured/visual tabs as the legacy NewProjectPanel: Prototype,
  // Live artifact, From template, and Other. Media tabs (image/video/
  // audio) produce non-canvas artifacts where "responsive web vs iOS"
  // has no rendering meaning.
  const tabSupportsPlatform =
    tab === 'prototype' ||
    tab === 'live-artifact' ||
    tab === 'template' ||
    tab === 'other';
  const concretePlatformTargets = useMemo(
    () => platformTargetsFor(normalizeSelectedPlatforms(platformTargets)),
    [platformTargets],
  );
  const canIncludeOsWidgets = useMemo(
    () => platformTargetsSupportOsWidgets(concretePlatformTargets),
    [concretePlatformTargets],
  );

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
      platformTargets,
      includeLandingPage,
      includeOsWidgets,
      templateId,
      templates,
      imageModel,
      imageAspect,
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
    platformTargets,
    includeLandingPage,
    includeOsWidgets,
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

        {tabSupportsPlatform ? (
          <PlatformPicker
            value={platformTargets}
            onChange={setPlatformTargets}
          />
        ) : null}

        {tabSupportsPlatform ? (
          <SurfaceOptions
            includeLandingPage={includeLandingPage}
            includeOsWidgets={includeOsWidgets}
            canIncludeOsWidgets={canIncludeOsWidgets}
            onIncludeLandingPage={setIncludeLandingPage}
            onIncludeOsWidgets={setIncludeOsWidgets}
          />
        ) : null}

        {tab === 'image' ? (
          <PromptTemplatePicker
            surface="image"
            templates={promptTemplates}
            value={imagePromptTemplate}
            onChange={handleImagePromptTemplate}
          />
        ) : null}

        {tab === 'video' ? (
          <PromptTemplatePicker
            surface="video"
            templates={promptTemplates}
            value={videoPromptTemplate}
            onChange={handleVideoPromptTemplate}
          />
        ) : null}

        {/* Live artifact always renders at high fidelity — its whole point
            is data-bound polished UI, so the wireframe option is hidden. */}
        {tab === 'prototype' ? (
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
              onDelete={onDeleteTemplate}
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
            mediaProviders={mediaProviders}
            onImageModel={setImageModel}
            onImageAspect={setImageAspect}
          />
        ) : null}

        {tab === 'video' ? (
          <MediaProjectOptions
            surface="video"
            videoModel={videoModel}
            videoAspect={videoAspect}
            videoLength={videoLength}
            mediaProviders={mediaProviders}
            onVideoModel={handleVideoModel}
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

/* ============================================================
   PlatformPicker — multi-select target platforms.
   Mirrors the visual language of the design-system trigger card so a
   user scanning the panel reads them as the same kind of control.
   Defaults to `['responsive']` when emptied; the panel never stores an
   empty selection.
   ============================================================ */
function PlatformPicker({
  value,
  onChange,
}: {
  value: NewProjectPlatform[];
  onChange: (v: NewProjectPlatform[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  function togglePlatform(next: NewProjectPlatform) {
    const active = value.includes(next);
    const updated = active
      ? value.filter((item) => item !== next)
      : [...value, next];
    onChange(updated.length > 0 ? updated : ['responsive']);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    const tid = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const primary =
    DESIGN_PLATFORMS.find((o) => o.value === value[0]) ?? null;
  const extraCount = Math.max(0, value.length - 1);

  return (
    <div
      className="newproj-section ds-picker platform-picker"
      data-testid="platform-picker"
      ref={wrapRef}
    >
      <label className="newproj-label">Target platforms</label>
      <button
        type="button"
        data-testid="platform-picker-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
      >
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? t(primary.labelKey) : 'Pick a platform'}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
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
        <div
          className="ds-picker-popover"
          id={listboxId}
          role="listbox"
          aria-label="Target platforms"
          aria-multiselectable="true"
        >
          <div className="ds-picker-list">
            {DESIGN_PLATFORMS.map((option) => {
              const active = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ds-picker-item${active ? ' active' : ''}`}
                  onClick={() => togglePlatform(option.value)}
                >
                  <span className="ds-picker-item-text">
                    <span className="ds-picker-item-title">
                      {t(option.labelKey)}
                    </span>
                    <span className="ds-picker-item-sub">
                      {t(option.hintKey)}
                    </span>
                  </span>
                  <span
                    className={`ds-picker-mark check${active ? ' active' : ''}`}
                    aria-hidden
                  >
                    {active ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
   SurfaceOptions — Companion-surfaces toggles.
   - Include landing page: a marketing/onboarding surface paired with
     the main product.
   - Include OS widgets: native widgets/complications that the agent
     should design alongside the app. Disabled when no mobile/tablet
     target is picked — desktop-web surfaces don't have an OS widget
     story.
   ============================================================ */
function SurfaceOptions({
  includeLandingPage,
  includeOsWidgets,
  canIncludeOsWidgets,
  onIncludeLandingPage,
  onIncludeOsWidgets,
}: {
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  canIncludeOsWidgets: boolean;
  onIncludeLandingPage: (v: boolean) => void;
  onIncludeOsWidgets: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section surface-options">
      <label className="newproj-label">
        {t('newproj.surfaceOptionsLabel')}
      </label>
      <div className="compact-toggle-list">
        <CompactToggle
          label={t('newproj.includeLandingPage')}
          hint={t('newproj.includeLandingPageHint')}
          checked={includeLandingPage}
          onChange={onIncludeLandingPage}
        />
        <CompactToggle
          label={t('newproj.includeOsWidgets')}
          hint={
            canIncludeOsWidgets
              ? t('newproj.includeOsWidgetsHint')
              : t('newproj.includeOsWidgetsDisabledHint')
          }
          checked={includeOsWidgets && canIncludeOsWidgets}
          disabled={!canIncludeOsWidgets}
          onChange={onIncludeOsWidgets}
        />
      </div>
    </div>
  );
}

// Lightweight inline toggle row used by SurfaceOptions. Hint becomes a
// native tooltip so the row stays one line tall — keeps the surface
// secondary controls visually subordinate to the full ToggleRow card
// used for primary toggles (speaker notes, animations).
function CompactToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`compact-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      aria-pressed={checked}
      disabled={disabled}
      title={hint}
    >
      <span className="compact-toggle-label">{label}</span>
      <span className="compact-toggle-switch" aria-hidden />
    </button>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
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
  onDelete,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
  onDelete?: (id: string) => Promise<boolean>;
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
                onDelete={
                  onDelete
                    ? async () => {
                        const ok = await onDelete(tpl.id);
                        if (ok && value === tpl.id) onChange(null);
                      }
                    : undefined
                }
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
  onDelete,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  /** When omitted the delete affordance is hidden — used by the
   *  FacetSetupPopover surface where template management belongs in
   *  Settings, not in a per-facet parameter sheet. */
  onDelete?: () => void;
  name: string;
  description: string;
}) {
  return (
    <div className={`template-option${active ? ' active' : ''}`}>
      <button
        type="button"
        className="template-option-select"
        onClick={onClick}
        aria-pressed={active}
      >
        <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
        <span className="template-option-text">
          <span className="template-option-name">{name}</span>
          <span className="template-option-desc">{description}</span>
        </span>
      </button>
      {onDelete ? (
        <button
          type="button"
          className="template-option-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete template"
          aria-label={`Delete template ${name}`}
        >
          ✕
        </button>
      ) : null}
    </div>
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
          <div className="ds-picker-list ds-picker-list-design-systems">
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
      mediaProviders?: Record<string, MediaProviderCredentials>;
      onImageModel: (value: string) => void;
      onImageAspect: (value: MediaAspect) => void;
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Group models by provider once. The trigger row needs the same provider
  // metadata (label + status) to render the selected model's caption, so we
  // compute groups regardless of whether the popover is open.
  const groups = useMemo(() => {
    const out: Array<{
      providerId: string;
      providerLabel: string;
      status: 'configured' | 'integrated' | 'unsupported';
      models: MediaModel[];
    }> = [];
    for (const model of models) {
      const provider = findProvider(model.provider);
      const providerId = provider?.id ?? model.provider;
      const entry = mediaProviders?.[providerId];
      const configured =
        provider?.credentialsRequired === false ||
        isStoredMediaProviderEntryPresent(entry);
      let group = out.find((g) => g.providerId === providerId);
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
        out.push(group);
      }
      group.models.push(model);
    }
    return out;
  }, [models, mediaProviders]);

  const selected = useMemo(() => {
    for (const group of groups) {
      const hit = group.models.find((m) => m.id === value);
      if (hit) return { model: hit, group };
    }
    return null;
  }, [groups, value]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        models: g.models.filter((m) => {
          return (
            m.id.toLowerCase().includes(q) ||
            m.label.toLowerCase().includes(q) ||
            m.hint.toLowerCase().includes(q) ||
            g.providerLabel.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, query]);

  const totalMatches = filteredGroups.reduce((n, g) => n + g.models.length, 0);

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

  function pick(modelId: string) {
    onChange(modelId);
    setOpen(false);
    setQuery('');
  }

  const triggerTitle = selected?.model.label ?? t('newproj.modelMissingTitle');
  // The model.hint frequently leads with the provider name (e.g.
  // "OpenAI · 4K, native multimodal"), so emitting providerLabel as a
  // separate prefix would duplicate it. If the hint already opens with the
  // provider label, just use the hint verbatim — otherwise prefix it.
  const triggerSub = selected
    ? selected.model.hint.toLowerCase().startsWith(selected.group.providerLabel.toLowerCase())
      ? selected.model.hint
      : `${selected.group.providerLabel} · ${selected.model.hint}`
    : t('newproj.modelMissingSub');

  return (
    <div className="newproj-section ds-picker model-picker" ref={wrapRef}>
      <label className="newproj-label">{label}</label>
      <button
        type="button"
        data-testid="model-picker-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${selected ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
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
              data-testid="model-picker-search"
              className="ds-picker-search"
              placeholder={t('newproj.modelSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ds-picker-list">
            {totalMatches === 0 ? (
              <div className="ds-picker-empty">{t('newproj.modelEmpty')}</div>
            ) : (
              filteredGroups.map((group) => (
                <div className="ds-picker-group" key={group.providerId}>
                  <div className="ds-picker-group-head">
                    <span>{group.providerLabel}</span>
                    <span className={`newproj-provider-badge ${group.status}`}>
                      {group.status === 'configured'
                        ? 'Configured'
                        : group.status === 'integrated'
                          ? 'Integrated'
                          : 'Unsupported'}
                    </span>
                  </div>
                  {group.models.map((model) => {
                    const active = value === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-testid={`model-picker-option-${model.id}`}
                        className={`ds-picker-item${active ? ' active' : ''}`}
                        onClick={() => pick(model.id)}
                      >
                        <span className="ds-picker-item-text">
                          <span className="ds-picker-item-title">
                            {model.label}
                            {model.default ? (
                              <span className="ds-picker-item-badge">
                                {t('newproj.modelRecommended')}
                              </span>
                            ) : null}
                          </span>
                          <span className="ds-picker-item-sub">{model.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
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
      <div className="newproj-aspect-segmented" role="radiogroup" aria-label={label}>
        {MEDIA_ASPECTS.map((aspect) => {
          const active = value === aspect;
          return (
            <button
              key={aspect}
              type="button"
              role="radio"
              aria-checked={active}
              title={`${labels[aspect]} · ${aspect}`}
              className={`newproj-aspect-pill${active ? ' active' : ''}`}
              onClick={() => onChange(aspect)}
            >
              <span
                className={`newproj-aspect-icon newproj-aspect-icon-${aspect.replace(':', '-')}`}
                aria-hidden
              />
              <span className="newproj-aspect-ratio">{aspect}</span>
            </button>
          );
        })}
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
  platformTargets: NewProjectPlatform[];
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
  imageModel: string;
  imageAspect: MediaAspect;
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
  // `kind` and `tab` agree for every CreateTab except `live-artifact`,
  // which records `kind: 'prototype'` + an `intent: 'live-artifact'`
  // marker so downstream consumers that only branch on kind keep working.
  const kind: ProjectKind =
    input.tab === 'live-artifact' ? 'prototype' : input.tab;
  // Platform + companion-surface metadata. `selectedPlatforms[0]` is the
  // primary target (e.g. used by the chip in ProjectView's header);
  // `concreteTargets` is the full delivery surface set the agent must
  // account for. `includeOsWidgets` is silently dropped when no picked
  // platform supports it, matching the picker's disabled-state UX.
  const selectedPlatforms = normalizeSelectedPlatforms(input.platformTargets);
  const concreteTargets = platformTargetsFor(selectedPlatforms);
  const canIncludeOsWidgets = platformTargetsSupportOsWidgets(concreteTargets);
  const surfaceOptions = {
    ...(input.includeLandingPage ? { includeLandingPage: true } : {}),
    ...(input.includeOsWidgets && canIncludeOsWidgets
      ? { includeOsWidgets: true }
      : {}),
  };
  const base = {
    platform: selectedPlatforms[0],
    platformTargets: concreteTargets,
    ...surfaceOptions,
  };
  const inspirations = input.inspirationIds.length > 0
    ? { inspirationDesignSystemIds: input.inspirationIds }
    : {};
  if (input.tab === 'prototype' || input.tab === 'live-artifact') {
    return {
      kind,
      ...base,
      // Live artifact is locked to high fidelity (the picker is hidden in
      // the panel) — wireframe live artifacts don't make sense.
      fidelity: input.tab === 'live-artifact' ? 'high-fidelity' : input.fidelity,
      ...(input.tab === 'live-artifact' ? { intent: 'live-artifact' as const } : {}),
      ...inspirations,
    };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes, ...inspirations };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, ...base, animations: input.animations, ...inspirations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      ...base,
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
  return { kind: 'other', ...base, ...inspirations };
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
