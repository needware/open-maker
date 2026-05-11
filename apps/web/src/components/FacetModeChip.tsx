// FacetModeChip — the composer's persistent affordance for "what am I
// creating?". Visually a rounded pill with mode icon + mode name +
// (optional) skill name + caret. Clicking it opens the
// FacetSetupPopover, which hosts the full eight-tab parameter form
// (Prototype | Live artifact | Slide deck | From template | Image |
// Video | Audio | Other) — same controls as the pre-RFC NewProjectPanel.
//
// State: the chip is fully controlled — `currentMode` /
// `currentSkillId` / `currentDesignSystemId` / `currentMetadata` come
// from the parent (typically computed from `project.*`). On change,
// the parent persists via `patchProject` so the choice survives
// reloads.

import { useMemo, useRef, useState } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';
import type {
  DesignSystemSummary,
  MediaProviderCredentials,
  ProjectMetadata,
  ProjectTemplate,
  PromptTemplateSummary,
  SkillSummary,
} from '../types';
import type { FacetSelection } from './FacetParametersPanel';
import {
  FacetSetupPopover,
  FACET_MODE_ICON,
  FACET_MODE_LABEL,
  type FacetMode,
} from './FacetSetupPopover';
import { Icon } from './Icon';

interface Props {
  currentMode: FacetMode;
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
  onChange: (next: FacetSelection) => void;
  /** Disables the chip when a stream is in flight — changing mode mid-
   *  stream would be confusing (the running prompt was composed against
   *  the old skill). */
  disabled?: boolean;
}

export function FacetModeChip({
  currentMode,
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
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number; width: number } | null>(null);

  const currentSkill = useMemo(
    () => skills.find((s) => s.id === currentSkillId) ?? null,
    [skills, currentSkillId],
  );

  function handleClick() {
    if (disabled) return;
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
    setOpen(true);
  }

  // The chip's secondary text — the most informative single attribute
  // for the active skill. Falls back to the mode label when no skill is
  // chosen (first time the chip is rendered for a new project).
  const secondary = currentSkill ? buildSecondary(currentSkill) : null;
  const isLiveArtifact = currentMetadata?.intent === 'live-artifact';
  const isOther = currentSkillId == null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        data-testid="facet-mode-chip"
        title="What to create"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px 4px 6px',
          fontSize: 12,
          fontWeight: 500,
          color: 'inherit',
          background: open ? 'var(--surface-hover, rgba(0,0,0,0.06))' : 'var(--surface-soft, transparent)',
          border: '1px solid var(--border-soft)',
          borderRadius: 999,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          maxWidth: 240,
          minWidth: 0,
        }}
      >
        <Icon name={FACET_MODE_ICON[currentMode]} size={12} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isOther ? 'Other' : isLiveArtifact ? 'Live artifact' : FACET_MODE_LABEL[currentMode]}
          {!isOther && secondary ? (
            <span style={{ color: 'var(--text-faint)' }}> · {secondary}</span>
          ) : null}
        </span>
        <Icon name="chevron-down" size={10} />
      </button>
      {open && anchor ? (
        <FacetSetupPopover
          anchorRect={anchor}
          currentSkillId={currentSkillId}
          currentDesignSystemId={currentDesignSystemId}
          currentMetadata={currentMetadata}
          skills={skills}
          designSystems={designSystems}
          defaultDesignSystemId={defaultDesignSystemId}
          templates={templates}
          promptTemplates={promptTemplates}
          mediaProviders={mediaProviders}
          connectors={connectors}
          connectorsLoading={connectorsLoading}
          onOpenConnectorsTab={onOpenConnectorsTab}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Pick the most user-meaningful attribute of a skill for the chip's
 * compact secondary label. Prefers fidelity (Prototype's primary axis),
 * then platform, then surface — same priority order the
 * FacetParametersPanel uses for skill-card badges.
 */
function buildSecondary(skill: SkillSummary): string {
  if (skill.fidelity === 'wireframe') return 'Wireframe';
  if (skill.fidelity === 'high-fidelity') return 'Hi-fi';
  if (skill.platform === 'desktop') return 'Desktop';
  if (skill.platform === 'mobile') return 'Mobile';
  if (skill.scenario) return skill.scenario;
  return skill.name;
}
