import { expect, it } from 'vitest';

import { createScriptedRunner } from './scripted-runner.js';

import type { SourceDocument } from '../retrieval/drive-port.js';

const question = 'What are the triage runbook steps?';
const sources: readonly SourceDocument[] = [
  {
    id: 'alice-runbook',
    title: 'Triage runbook',
    text: 'Alice triage steps.',
    uri: 'https://drive.fake.test/d/alice-runbook',
  },
  {
    id: 'public-handbook',
    title: 'Public handbook',
    text: 'Anyone may read this handbook.',
    uri: 'https://drive.fake.test/d/public-handbook',
  },
];

it('rejects a Gemini answer that stopped because it hit the token limit', async () => {
  const runner = createScriptedRunner({
    baseUrl: 'http://llm.test',
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          candidates: [
            {
              content: { parts: [{ text: 'Follow the tri' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
        }),
      ),
  });
  await expect(runner.run({ question, sources })).rejects.toMatchObject({ name: 'RunnerError' });
});

it('rejects a Gemini answer that has not stopped normally', async () => {
  const runner = createScriptedRunner({
    baseUrl: 'http://llm.test',
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          candidates: [
            {
              content: { parts: [{ text: 'Follow the triage steps in the Triage runbook.' }] },
            },
          ],
        }),
      ),
  });
  await expect(runner.run({ question, sources })).rejects.toMatchObject({ name: 'RunnerError' });
});

it('returns a stopped answer and only the sources named in it', async () => {
  const runner = createScriptedRunner({
    baseUrl: 'http://llm.test',
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: 'Follow the triage steps in the Triage runbook.' }],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ),
  });
  await expect(runner.run({ question, sources })).resolves.toEqual({
    answer: 'Follow the triage steps in the Triage runbook.',
    citedSourceIds: ['alice-runbook'],
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
