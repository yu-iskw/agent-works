import { Gemini } from '@google/adk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLiveModel,
  liveCallSignal,
  readVertexConfig,
  requireVertexConfig,
} from './live-model.js';

const env = {
  GOOGLE_CLOUD_PROJECT: 'demo-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
  VERTEX_MODEL_ID: 'gemini-test',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readVertexConfig', () => {
  it('reads the variables with defaults', () => {
    expect(readVertexConfig(env)).toEqual({
      project: 'demo-project',
      location: 'us-central1',
      modelId: 'gemini-test',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
    });
  });

  it('honours VERTEX_TIMEOUT_MS and ignores invalid values', () => {
    expect(readVertexConfig({ ...env, VERTEX_TIMEOUT_MS: '1500' })).toMatchObject({
      timeoutMs: 1500,
    });
    expect(readVertexConfig({ ...env, VERTEX_TIMEOUT_MS: 'abc' })).toMatchObject({
      timeoutMs: 60_000,
    });
  });

  it('lists every missing variable', () => {
    expect(readVertexConfig({ GOOGLE_CLOUD_PROJECT: ' ' })).toEqual({
      missing: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_MODEL_ID'],
    });
  });
});

describe('requireVertexConfig', () => {
  it('throws an actionable error naming the missing variables', () => {
    expect(() => requireVertexConfig({ GOOGLE_CLOUD_PROJECT: 'p' })).toThrow(
      /GOOGLE_CLOUD_LOCATION, VERTEX_MODEL_ID/,
    );
  });

  it('returns the config when complete', () => {
    expect(requireVertexConfig(env).modelId).toBe('gemini-test');
  });
});

describe('createLiveModel', () => {
  it('builds a Vertex Gemini without any outbound call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generate = vi.spyOn(Gemini.prototype, 'generateContentAsync');
    const config = requireVertexConfig(env);

    const model = createLiveModel(config);

    expect(model).toBeInstanceOf(Gemini);
    expect(model.model).toBe('gemini-test');
    expect(model).toMatchObject({
      vertexai: true,
      project: 'demo-project',
      location: 'us-central1',
    });
    expect(model).not.toHaveProperty('apiKey', expect.any(String));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('derives the per-call abort signal from the configured timeout', () => {
    const signal = liveCallSignal(requireVertexConfig({ ...env, VERTEX_TIMEOUT_MS: '5' }));
    expect(signal.aborted).toBe(false);
  });
});
