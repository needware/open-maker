// FacetSetupPopover — the parameter sheet that opens from the
// composer's FacetModeChip. Hosts the full pre-RFC NewProjectPanel
// form (now `FacetParametersPanel`) so users get the same eight-tab
// operation panel they had before — Prototype / Live artifact / Slide
// deck / From template / Image / Video / Audio / Other — with the
// same per-tab controls (FidelityPicker, DesignSystemPicker, Speaker
// notes / Animations toggles, MediaProjectOptions, PromptTemplatePicker,
// ConnectorsSection).
//
// Lifecycle: rendered with `position: fixed` anchored to the chip's
// bounding rect; outside-click and Escape close it. Selections flow
// up via `onChange` after every parameter change so the parent can
// patchProject() without waiting for a "submit" gesture (there isn't
// one — the project already exists).

import { useEffect, useMemo, useRef } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';
import type {
  DesignSystemSummary,
  MediaProviderCredentials,
  ProjectMetadata,
  ProjectTemplate,
  PromptTemplateSummary,
  SkillSummary,
} from '../types';
import { FacetParametersPanel, type FacetSelection } from './FacetParametersPanel';
import { Icon } from './Icon';

// FacetMode is the *contract* mode (seven values) used for the chip's
// label and icon. The popover internally hosts an eight-tab UI
// (`CreateTab`) that's a superset — `live-artifact` and `other` are
// pure UI variants that don't add new contract modes.
export type FacetMode = SkillSummary['mode'];

export const FACET_MODES: FacetMode[] = [
  'prototype',
  'deck',
  'template',
  'design-system',
  'image',
  'video',
  'audio',
];

export const FACET_MODE_LABEL: Record<FacetMode, string> = {
  prototype: 'Prototype',
  deck: 'Slide deck',
  template: 'From template',
  'design-system': 'Design system',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

export const FACET_MODE_ICON: Record<FacetMode, Parameters<typeof Icon>[0]['name']> = {
  prototype: 'grid',
  deck: 'present',
  template: 'file-code',
  'design-system': 'orbit',
  image: 'image',
  video: 'play',
  audio: 'mic',
};

interface Props {
  /** DOMRect of the trigger button (chip). The popover positions itself
   *  immediately above the trigger so it doesn't cover the textarea
   *  when the chip is rendered in the composer's leading area. */
  anchorRect: { left: number; top: number; bottom: number; width: number };
  currentSkillId: string | null;
  currentDesignSystemId: string | null;
  currentMetadata?: ProjectMetadata;
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  promptTemplates: PromptTemplateSummary[];
  mediaProviders?: Record<string, MediaProviderCredentials>;
  connectors?: ConnectorDetail[];
  connectorsLoading?: boolean;
  onOpenConnectorsTab?: () => void;
  /** Fired on every parameter change. Always carries the *full* next
   *  selection so the parent doesn't need to merge against current
   *  state. */
  onChange: (next: FacetSelection) => void;
  onClose: () => void;
}

export function FacetSetupPopover({
  anchorRect,
  currentSkillId,
  currentDesignSystemId,
  currentMetadata,
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  promptTemplates,
  mediaProviders,
  connectors,
  connectorsLoading,
  onOpenConnectorsTab,
  onChange,
  onClose,
}: Props) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Outside-click + Escape. Mirrors the avatar / project-switcher
  // patterns elsewhere in this app.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Width of the panel: wide enough to host the original two-column
  // skill grid, design-system picker, and media options without
  // horizontal cramping. Height is capped to leave breathing room
  // above/below the composer; the inner panel scrolls when content
  // overflows.
  const PANEL_W = 560;
  const PANEL_MAX_H = useMemo(
    () => Math.min(typeof window === 'undefined' ? 720 : window.innerHeight - 80, 720),
    [],
  );

  const left = useMemo(
    () =>
      Math.max(
        8,
        Math.min(anchorRect.left, (typeof window === 'undefined' ? 1024 : window.innerWidth) - PANEL_W - 8),
      ),
    [anchorRect.left],
  );
  const aboveTop = anchorRect.top - PANEL_MAX_H - 8;
  const belowTop = anchorRect.bottom + 8;
  const placeAbove = aboveTop >= 8;
  const top = placeAbove ? aboveTop : belowTop;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Facet setup"
      data-testid="facet-setup-popover"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 1500,
        width: PANEL_W,
        maxHeight: PANEL_MAX_H,
        background: 'var(--surface, #fff)',
        border: '1px solid var(--border-soft)',
        borderRadius: 12,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
    >
      <FacetParametersPanel
        skills={skills}
        designSystems={designSystems}
        defaultDesignSystemId={defaultDesignSystemId}
        templates={templates}
        promptTemplates={promptTemplates}
        currentSkillId={currentSkillId}
        currentDesignSystemId={currentDesignSystemId}
        currentMetadata={currentMetadata}
        mediaProviders={mediaProviders}
        connectors={connectors}
        connectorsLoading={connectorsLoading}
        onOpenConnectorsTab={onOpenConnectorsTab}
        onChange={onChange}
      />
    </div>
  );
}
