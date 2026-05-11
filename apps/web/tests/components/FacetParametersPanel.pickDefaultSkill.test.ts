import { describe, expect, it } from 'vitest';
import { pickDefaultSkillIdForTab } from '../../src/components/FacetParametersPanel';
import type { SkillSummary } from '../../src/types';

// Minimal SkillSummary builder — only the fields pickDefaultSkillIdForTab
// actually reads. Anything else is filled with reasonable defaults so the
// type-check stays honest without forcing every test to spell out 20
// unrelated fields.
function makeSkill(overrides: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'mode'>): SkillSummary {
  return {
    name: overrides.id,
    description: '',
    triggers: [],
    surface: undefined,
    platform: null,
    scenario: null,
    previewType: 'html',
    designSystemRequired: false,
    defaultFor: [],
    upstream: null,
    featured: null,
    fidelity: null,
    speakerNotes: null,
    animations: null,
    craftRequires: [],
    hasBody: true,
    examplePrompt: '',
    ...overrides,
  } as SkillSummary;
}

// These tests pin the behavior that fixes the
// "Selecting Video shows From template" bug: the media tabs must
// prefer skills whose mode matches the tab over skills that merely
// share the surface. Hyperframes-style template skills carry
// `surface: video` while their `mode` is `template`; auto-binding one
// of those would trigger FacetModeChip to render "From template" while
// the popover stays on the Video tab.
describe('pickDefaultSkillIdForTab', () => {
  describe('media tabs', () => {
    const realVideoA = makeSkill({ id: 'hyperframes', mode: 'video', surface: 'video' });
    const realVideoB = makeSkill({ id: 'video-shortform', mode: 'video', surface: 'video' });
    const videoTemplateA = makeSkill({
      id: 'swiss-video-template',
      mode: 'template',
      surface: 'video',
    });
    const videoTemplateB = makeSkill({
      id: '8-bit-orbit-video-template',
      mode: 'template',
      surface: 'video',
    });

    it('picks a mode:video skill, never a mode:template skill that just shares the surface', () => {
      // Order matters here: even if a template skill is listed first, a
      // mode:video skill must win. The previous bug was a pure
      // first-match-wins fallback against a union filter.
      const skills = [videoTemplateA, videoTemplateB, realVideoA, realVideoB];
      expect(pickDefaultSkillIdForTab('video', skills)).toBe('hyperframes');
    });

    it('honors explicit default_for: video on a mode:video skill', () => {
      const skills = [
        realVideoA,
        makeSkill({
          id: 'video-shortform',
          mode: 'video',
          surface: 'video',
          defaultFor: ['video'],
        }),
        videoTemplateA,
      ];
      expect(pickDefaultSkillIdForTab('video', skills)).toBe('video-shortform');
    });

    it('falls back to surface:video skills only when no mode:video skill exists', () => {
      const skills = [videoTemplateA, videoTemplateB];
      expect(pickDefaultSkillIdForTab('video', skills)).toBe('swiss-video-template');
    });

    it('returns null when no candidate matches the media tab', () => {
      const skills = [
        makeSkill({ id: 'web-prototype', mode: 'prototype' }),
        makeSkill({ id: 'guizang-ppt', mode: 'deck' }),
      ];
      expect(pickDefaultSkillIdForTab('video', skills)).toBeNull();
    });

    it('image tab picks a mode:image skill over a surface:image template', () => {
      const skills = [
        makeSkill({ id: 'image-template', mode: 'template', surface: 'image' }),
        makeSkill({ id: 'image-poster', mode: 'image', surface: 'image' }),
      ];
      expect(pickDefaultSkillIdForTab('image', skills)).toBe('image-poster');
    });

    it('audio tab picks a mode:audio skill over a surface:audio template', () => {
      const skills = [
        makeSkill({ id: 'audio-template', mode: 'template', surface: 'audio' }),
        makeSkill({ id: 'audio-jingle', mode: 'audio', surface: 'audio' }),
      ];
      expect(pickDefaultSkillIdForTab('audio', skills)).toBe('audio-jingle');
    });
  });

  describe('non-media tabs', () => {
    const protoDefault = makeSkill({
      id: 'web-prototype',
      mode: 'prototype',
      defaultFor: ['prototype'],
    });
    const protoOther = makeSkill({ id: 'mobile-onboarding', mode: 'prototype' });
    const deckDefault = makeSkill({
      id: 'guizang-ppt',
      mode: 'deck',
      defaultFor: ['deck'],
    });
    const liveArtifact = makeSkill({ id: 'live-artifact', mode: 'prototype' });

    it('prototype tab honors default_for', () => {
      expect(pickDefaultSkillIdForTab('prototype', [protoOther, protoDefault])).toBe(
        'web-prototype',
      );
    });

    it('deck tab honors default_for', () => {
      expect(pickDefaultSkillIdForTab('deck', [deckDefault])).toBe('guizang-ppt');
    });

    it('live-artifact tab matches by id, then by content hint, then falls back to a prototype', () => {
      expect(
        pickDefaultSkillIdForTab('live-artifact', [protoDefault, liveArtifact]),
      ).toBe('live-artifact');
      const noLiveArtifact = [protoDefault, protoOther];
      expect(pickDefaultSkillIdForTab('live-artifact', noLiveArtifact)).toBe(
        'web-prototype',
      );
    });

    it('template and other tabs return null (no auto-bound skill)', () => {
      expect(pickDefaultSkillIdForTab('template', [protoDefault])).toBeNull();
      expect(pickDefaultSkillIdForTab('other', [protoDefault])).toBeNull();
    });
  });
});
