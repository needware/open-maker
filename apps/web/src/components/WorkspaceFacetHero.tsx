// WorkspaceFacetHero — the empty-state teaching surface that fills the
// workspace column the first time a user lands inside a project. Shows
// the seven facet modes as discoverable cards. Clicking a card sets the
// composer's mode chip and focuses the textarea so the user can start
// typing a brief immediately.
//
// The hero is *not* a wizard — it doesn't gate progress. The user can
// also just type a brief in the composer below; the hero merely
// teaches the seven modes that exist. Once the project has any
// generated artifact (run history, files, live artifact), the hero
// auto-disappears and the workspace shows real content instead.

import type { SkillSummary } from '../types';
import { FACET_MODES, FACET_MODE_ICON, FACET_MODE_LABEL, type FacetMode } from './FacetSetupPopover';
import { Icon } from './Icon';

const MODE_BLURB: Record<FacetMode, string> = {
  prototype: 'Static or interactive UI mocks',
  deck: 'Slide decks and pitch decks',
  template: 'Reusable starting points',
  'design-system': 'Tokens, components, brand',
  image: 'Generated illustrations & art',
  video: 'Storyboards and rendered video',
  audio: 'Voice, music, sound design',
};

interface Props {
  projectName: string;
  skills: SkillSummary[];
  /** Click on a mode card triggers this. Parent commits the mode +
   *  default skill to project metadata, then focuses the composer. */
  onPickMode: (mode: FacetMode) => void;
}

export function WorkspaceFacetHero({ projectName, skills, onPickMode }: Props) {
  // A mode is "available" only if at least one non-aggregator skill
  // exists in that mode. Disabled cards stay visible (so the seven
  // modes always read as the canonical taxonomy) but render greyed
  // out and don't fire `onPickMode`.
  const skillCountsByMode = countSkillsByMode(skills);

  return (
    <div
      data-testid="workspace-facet-hero"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        padding: '64px 24px',
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>What do you want to make?</h2>
        <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>
          in <strong>{projectName}</strong>
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 200px))',
          gap: 12,
          justifyContent: 'center',
          width: '100%',
          maxWidth: 720,
        }}
      >
        {FACET_MODES.map((mode) => {
          const available = (skillCountsByMode[mode] ?? 0) > 0;
          return (
            <ModeCard
              key={mode}
              mode={mode}
              blurb={MODE_BLURB[mode]}
              disabled={!available}
              onClick={() => available && onPickMode(mode)}
            />
          );
        })}
      </div>

      <p
        style={{
          fontSize: 12,
          color: 'var(--text-faint)',
          margin: 0,
          textAlign: 'center',
        }}
      >
        Or just describe it in the chat below.
      </p>
    </div>
  );
}

function ModeCard({
  mode,
  blurb,
  disabled,
  onClick,
}: {
  mode: FacetMode;
  blurb: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={`workspace-mode-card-${mode}`}
      title={disabled ? `No skills installed for ${FACET_MODE_LABEL[mode]} yet` : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        padding: '14px 14px 16px',
        textAlign: 'left',
        background: 'var(--surface, transparent)',
        border: '1px solid var(--border-soft)',
        borderRadius: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: 'inherit',
        opacity: disabled ? 0.5 : 1,
        transition: 'transform 80ms ease, border-color 80ms ease',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = 'var(--accent, currentColor)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-soft)';
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 8,
          background: 'var(--surface-soft, rgba(0,0,0,0.05))',
        }}
      >
        <Icon name={FACET_MODE_ICON[mode]} size={16} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{FACET_MODE_LABEL[mode]}</div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.35 }}>{blurb}</div>
    </button>
  );
}

function countSkillsByMode(skills: SkillSummary[]): Partial<Record<FacetMode, number>> {
  const out: Partial<Record<FacetMode, number>> = {};
  for (const s of skills) {
    if (s.aggregatesExamples) continue;
    out[s.mode] = (out[s.mode] ?? 0) + 1;
  }
  return out;
}
