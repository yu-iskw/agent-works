import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalPayloadSha256 } from '@agent-works/domain';

import type { Handler } from './http.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const helloFixturePath = resolve(fixtureDirectory, '../fixtures/llm/hello.json');
const triageFixturePath = resolve(fixtureDirectory, '../fixtures/llm/triage.json');

const scripts = loadScripts();

export function createLlm(): Handler {
  return (request) => {
    if (request.method !== 'POST' || !request.url.pathname.endsWith(':generateContent')) {
      return { status: 404, body: { error: 'not found' } };
    }
    let key = '';
    try {
      key = canonicalPayloadSha256(JSON.parse(request.body.toString('utf8')) as unknown);
    } catch {
      return { status: 599, body: { error: 'unknown script', key } };
    }
    const response = scripts.get(key);
    return response === undefined
      ? { status: 599, body: { error: 'unknown script', key } }
      : { status: 200, body: response };
  };
}

function loadScripts(): Map<string, unknown> {
  const scripts = new Map<string, unknown>();
  addFixture(scripts, readFileSync(helloFixturePath, 'utf8'));
  addFixture(scripts, readFileSync(triageFixturePath, 'utf8'));
  return scripts;
}

function addFixture(scripts: Map<string, unknown>, source: string): void {
  const parsed: unknown = JSON.parse(source);
  if (!isFixture(parsed)) return;
  scripts.set(canonicalPayloadSha256(parsed.request), parsed.response);
}

function isFixture(value: unknown): value is { request: unknown; response: unknown } {
  return typeof value === 'object' && value !== null && 'request' in value && 'response' in value;
}
