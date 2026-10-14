import { expect, it, vi } from 'vitest';

import { createMemoryModelRoutingPort } from '../ports/memory/model-routing.js';

import { approvedDefault, defaultIdentity, inferenceContext } from './fixtures.js';
import { createModelRouter } from './router.js';
import { createRoutedScriptedRunner } from './scripted-runner.js';
it('adds the routing authorization hook after suspension and before scripted transport', async () => {
  const order: string[] = [];
  const load = vi.fn(() => {
    order.push('transport');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'source-1' }] }, finishReason: 'STOP' }],
        }),
      ),
    );
  });
  const records = createMemoryModelRoutingPort();
  const router = createModelRouter({
    policy: { defaultModel: defaultIdentity, allowlist: [approvedDefault], rules: [] },
    benchmarks: { enabled: () => Promise.resolve(false) },
    records,
  });
  const runner = createRoutedScriptedRunner(
    { baseUrl: 'https://llm.fake.test', fetch: load },
    router,
    inferenceContext,
  );
  await runner.run({
    question: 'research',
    sources: [],
    beforeModelCall: () => {
      order.push('suspension');
      return Promise.resolve();
    },
    authorizeModelCall: () => {
      order.push('routing');
      return Promise.resolve();
    },
  });
  expect(order).toEqual(['suspension', 'routing', 'transport']);
  expect(load.mock.calls[0]).toBeDefined();
  expect(await records.inferences('routing-task')).toMatchObject([
    { model: defaultIdentity, status: 'succeeded' },
  ]);
});
it('a failed suspension prevents both routing hook and transport', async () => {
  const load = vi.fn();
  const authorizeModelCall = vi.fn();
  const router = createModelRouter({
    policy: { defaultModel: defaultIdentity, allowlist: [approvedDefault], rules: [] },
    benchmarks: { enabled: () => Promise.resolve(false) },
    records: createMemoryModelRoutingPort(),
  });
  const runner = createRoutedScriptedRunner(
    { baseUrl: 'https://llm.fake.test', fetch: load },
    router,
    inferenceContext,
  );
  await expect(
    runner.run({
      question: 'research',
      sources: [],
      beforeModelCall: () => Promise.reject(new Error('suspended')),
      authorizeModelCall,
    }),
  ).rejects.toThrow('suspended');
  expect(authorizeModelCall).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});
