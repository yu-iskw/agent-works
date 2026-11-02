import { createAdkRunner, FetchLlm } from '@agent-works/agent-runtime';
import { runnerLimitsSchema } from '@agent-works/domain';
import { createLlm, listen } from '@agent-works/fakes';
import { describe, expect, it } from 'vitest';

import { beforeModelCall } from '../suspension/runtime.js';

import { createScriptedRunner } from './scripted-runner.js';

import type { SourceDocument } from '../retrieval/drive-port.js';
import type { RunnerLimits } from '@agent-works/domain';

const triageQuestion = 'What are the triage runbook steps?';
const triageAnswer = 'Follow the triage steps in the Triage runbook.';

const triageSource: SourceDocument = {
  id: 'alice-runbook',
  title: 'Triage runbook',
  text: 'Alice triage steps.',
  uri: 'https://drive.fake.test/d/alice-runbook',
};

function limits(overrides: Partial<RunnerLimits> = {}): RunnerLimits {
  return runnerLimitsSchema.parse({
    maxSteps: 4,
    maxToolCalls: 4,
    maxCostUsd: 1,
    maxElapsedMs: 1000,
    maxBytesRetrieved: 10,
    maxGeneratedOutputs: 1,
    maxModelRetries: 1,
    maxSubagents: 0,
    maxParallelToolCalls: 1,
    ...overrides,
  });
}

async function startLlm(): Promise<{
  url: string;
  posts: () => number;
  close: () => Promise<void>;
}> {
  const handle = createLlm();
  let posts = 0;
  const server = await listen((request) => {
    if (request.method === 'POST') posts += 1;
    return handle(request);
  }, 0);
  return { url: server.url, posts: () => posts, close: server.close };
}

describe('createAdkRunner parity with the scripted runner', () => {
  it('agent.runner-parity', async () => {
    const llm = await startLlm();
    try {
      const input = { question: triageQuestion, sources: [triageSource] };
      const scripted = createScriptedRunner({ baseUrl: llm.url });
      const adk = createAdkRunner({
        model: new FetchLlm({ baseUrl: llm.url }),
        limits: limits(),
        beforeModelCall,
      });
      const [fromScript, fromAdk] = await Promise.all([scripted.run(input), adk.run(input)]);
      expect(fromAdk.answer).toBe(triageAnswer);
      expect(fromAdk.citedSourceIds).toEqual(['alice-runbook']);
      expect(fromAdk).toEqual(fromScript);
    } finally {
      await llm.close();
    }
  });

  it('keeps ADK LLM calls within 1.5 times the scripted runner', async () => {
    const llm = await startLlm();
    try {
      const input = { question: triageQuestion, sources: [triageSource] };
      const scripted = createScriptedRunner({ baseUrl: llm.url });
      const adk = createAdkRunner({
        model: new FetchLlm({ baseUrl: llm.url }),
        limits: limits(),
        beforeModelCall,
      });
      // Count model calls as deterministic work; few-ms wall-clock timings are CI noise.
      await scripted.run(input);
      const scriptedCalls = llm.posts();
      await adk.run(input);
      const adkCalls = llm.posts() - scriptedCalls;
      expect(scriptedCalls).toBe(1);
      expect(adkCalls).toBe(1);
      expect(adkCalls).toBeLessThanOrEqual(scriptedCalls * 1.5);
    } finally {
      await llm.close();
    }
  });
});
