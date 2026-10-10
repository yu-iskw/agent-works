import { canonicalPayloadSha256 } from '@agent-works/domain';

import hello from '../fixtures/llm/hello.json' with { type: 'json' };

import type { Handler } from './http.js';

const scripts = new Map<string, unknown>([[canonicalPayloadSha256(hello.request), hello.response]]);

export function createLlm(): Handler {
  return (request) => {
    if (request.method !== 'POST' || !request.url.pathname.endsWith(':generateContent')) {
      return { status: 404, body: { error: 'not found' } };
    }
    return scriptReply(request.body.toString('utf8'));
  };
}

function scriptReply(text: string): { status: number; body: unknown } {
  let key = '';
  try {
    key = canonicalPayloadSha256(JSON.parse(text) as unknown);
  } catch {
    return { status: 599, body: { error: 'unknown script', key } };
  }
  const response = scripts.get(key);
  return response === undefined
    ? { status: 599, body: { error: 'unknown script', key } }
    : { status: 200, body: response };
}
