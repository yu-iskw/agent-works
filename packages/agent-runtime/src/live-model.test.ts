import { Gemini } from '@google/adk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLiveModel, readVertexConfig, requireVertexConfig } from './live-model.js';

import type { LlmRequest, LlmResponse } from '@google/adk';

async function* noResponses(): AsyncGenerator<LlmResponse, void> {
  await Promise.resolve();
}

function captureRequests(): LlmRequest[] {
  const sent: LlmRequest[] = [];
  vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation((request) => {
    sent.push(request);
    return noResponses();
  });
  return sent;
}

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

  it('puts the configured timeout and output cap on the outgoing request', async () => {
    const sent = captureRequests();
    const model = createLiveModel(
      requireVertexConfig({ ...env, VERTEX_TIMEOUT_MS: '1500', VERTEX_MAX_OUTPUT_TOKENS: '256' }),
    );
    const request = {
      contents: [],
      config: { temperature: 0, httpOptions: { headers: { 'x-trace': 'a' } } },
    } as unknown as LlmRequest;

    for await (const response of model.generateContentAsync(request)) void response;

    expect(sent).toHaveLength(1);
    expect(sent[0]?.config).toEqual({
      temperature: 0,
      maxOutputTokens: 256,
      httpOptions: { headers: { 'x-trace': 'a' }, timeout: 1500 },
    });
  });

  it('applies the documented defaults when the variables are unset', async () => {
    const sent = captureRequests();
    const model = createLiveModel(requireVertexConfig(env));

    for await (const response of model.generateContentAsync({
      contents: [],
    } as unknown as LlmRequest)) {
      void response;
    }

    expect(sent[0]?.config).toEqual({ maxOutputTokens: 4096, httpOptions: { timeout: 60_000 } });
  });
});
