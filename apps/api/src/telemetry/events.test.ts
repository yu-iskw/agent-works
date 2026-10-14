import { expect, it } from 'vitest';

import { createRedactor } from './events-redaction.js';
import { eventJsonLines, parseEventJsonLines, structuredEvent } from './events.js';

import type { EventInput } from './events.js';

const key = 'fixture-key-never-use-in-production';
const canary = 'CANARY_TOKEN_prompt_do_not_export';
const input: EventInput = {
  eventId: canary,
  kind: 'task.accepted',
  occurredAt: '2026-10-10T10:00:00.000Z',
  taskId: canary,
  sessionId: canary,
  traceId: canary,
  userSubject: canary,
  agentPrincipal: canary,
  skillVersion: canary,
  model: canary,
  tool: canary,
  policyVersion: canary,
  sponsor: canary,
  latencyMs: 25,
  costEstimateMicros: 5,
  retries: 0,
  outcome: 'success',
  sideEffectKey: canary,
};
it('never exports canary tokens or prompt text from labels or unknown fields', () => {
  const event = structuredEvent(
    { ...input, prompt: canary, token: canary } as EventInput,
    createRedactor(key),
  );
  const output = eventJsonLines([event]);
  expect(output).not.toContain(canary);
  expect(output).not.toContain('prompt');
  expect(output).not.toContain('token');
  expect(parseEventJsonLines(output)).toEqual([event]);
});
it('rejects raw recorded labels and extra fields on ingestion', () => {
  const event = structuredEvent(input, createRedactor(key));
  expect(() => parseEventJsonLines(JSON.stringify({ ...event, model: canary }))).toThrow();
  expect(() => parseEventJsonLines(JSON.stringify({ ...event, prompt: canary }))).toThrow();
});
it('uses stable pseudonyms under the same key and separates keys', () => {
  expect(createRedactor(key).protect(canary)).toBe(createRedactor(key).protect(canary));
  expect(createRedactor('different-protected-fixture-key').protect(canary)).not.toBe(
    createRedactor(key).protect(canary),
  );
  expect(() => createRedactor('short')).toThrow();
});
it('rejects unsafe numbers and malformed dates', () => {
  expect(() => structuredEvent({ ...input, latencyMs: Infinity }, createRedactor(key))).toThrow();
  expect(() => structuredEvent({ ...input, occurredAt: canary }, createRedactor(key))).toThrow();
});
