import { describe, expect, it } from 'vitest';
import { mergeFacetMetadata } from '../../src/components/FacetParametersPanel';
import type { ProjectMetadata } from '../../src/types';

// These tests pin the behavior that fixes the
// "FacetModeChip stays on Live artifact after switching to Video" bug:
// the panel must fully replace the tab-shaped fields it owns, while
// leaving system-owned fields (baseDir, importedFrom, …) alone.
describe('mergeFacetMetadata', () => {
  it('returns the next metadata verbatim when there is no existing slice', () => {
    const next: ProjectMetadata = {
      kind: 'video',
      videoModel: 'seedance-2.0',
      videoAspect: '16:9',
      videoLength: 5,
    };
    expect(mergeFacetMetadata(undefined, next)).toEqual(next);
  });

  it('drops the live-artifact intent when switching to a media tab', () => {
    const existing: ProjectMetadata = {
      kind: 'prototype',
      intent: 'live-artifact',
      fidelity: 'high-fidelity',
    };
    const next: ProjectMetadata = {
      kind: 'video',
      videoModel: 'seedance-2.0',
      videoAspect: '16:9',
      videoLength: 5,
    };
    const merged = mergeFacetMetadata(existing, next);
    expect(merged.intent).toBeUndefined();
    expect(merged.fidelity).toBeUndefined();
    expect(merged.kind).toBe('video');
    expect(merged.videoModel).toBe('seedance-2.0');
  });

  it('clears stale image fields when switching from image to audio', () => {
    const existing: ProjectMetadata = {
      kind: 'image',
      imageModel: 'gpt-image-2',
      imageAspect: '1:1',
      imageStyle: 'editorial',
    };
    const next: ProjectMetadata = {
      kind: 'audio',
      audioKind: 'speech',
      audioModel: 'minimax-tts',
      audioDuration: 10,
    };
    const merged = mergeFacetMetadata(existing, next);
    expect(merged.imageModel).toBeUndefined();
    expect(merged.imageAspect).toBeUndefined();
    expect(merged.imageStyle).toBeUndefined();
    expect(merged.audioModel).toBe('minimax-tts');
  });

  it('clears template fields when leaving the template tab', () => {
    const existing: ProjectMetadata = {
      kind: 'template',
      templateId: 'tpl-123',
      templateLabel: 'Magazine starter',
      animations: true,
    };
    const next: ProjectMetadata = {
      kind: 'prototype',
      fidelity: 'wireframe',
    };
    const merged = mergeFacetMetadata(existing, next);
    expect(merged.templateId).toBeUndefined();
    expect(merged.templateLabel).toBeUndefined();
    expect(merged.animations).toBeUndefined();
    expect(merged.fidelity).toBe('wireframe');
  });

  it('preserves system-owned fields the panel never writes', () => {
    const existing: ProjectMetadata = {
      kind: 'prototype',
      intent: 'live-artifact',
      baseDir: '/Users/me/projects/landing',
      importedFrom: 'folder',
      entryFile: 'index.html',
      sourceFileName: 'landing.html',
      linkedDirs: ['/Users/me/projects/shared'],
    };
    const next: ProjectMetadata = {
      kind: 'video',
      videoModel: 'seedance-2.0',
      videoAspect: '16:9',
      videoLength: 5,
    };
    const merged = mergeFacetMetadata(existing, next);
    expect(merged.baseDir).toBe('/Users/me/projects/landing');
    expect(merged.importedFrom).toBe('folder');
    expect(merged.entryFile).toBe('index.html');
    expect(merged.sourceFileName).toBe('landing.html');
    expect(merged.linkedDirs).toEqual(['/Users/me/projects/shared']);
    expect(merged.intent).toBeUndefined();
  });

  it('lets the next slice override system-shaped keys when explicitly set', () => {
    const existing: ProjectMetadata = {
      kind: 'prototype',
      baseDir: '/old/path',
    };
    const next: ProjectMetadata = {
      kind: 'prototype',
      fidelity: 'high-fidelity',
      baseDir: '/new/path',
    };
    expect(mergeFacetMetadata(existing, next).baseDir).toBe('/new/path');
  });

  it('always lets the next kind win', () => {
    const existing: ProjectMetadata = { kind: 'prototype', intent: 'live-artifact' };
    const next: ProjectMetadata = { kind: 'audio', audioKind: 'speech', audioModel: 'm', audioDuration: 5 };
    expect(mergeFacetMetadata(existing, next).kind).toBe('audio');
  });
});
