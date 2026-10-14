import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalPayloadSha256 } from '@agent-works/domain';

import type { Handler } from './http.js';

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/llm');
const claimsApprovalPath = resolve(fixtureDirectory, 'claims-approval.json');
const helloFixturePath = resolve(fixtureDirectory, 'hello.json');
const hostileFollowPath = resolve(fixtureDirectory, 'hostile-follow.json');
const loopingPath = resolve(fixtureDirectory, 'looping.json');
const triageFixturePath = resolve(fixtureDirectory, 'triage.json');
const triageSourceDataPath = resolve(fixtureDirectory, 'triage-source-data.json');
const unknownScript = 'unknown script';
const badFixture = 'llm fixture';

const scripts = loadScripts();

type CueScript = { cue: string; response: unknown };

export function createLlm(): Handler {
  return (request) => {
    if (request.method !== 'POST' || !request.url.pathname.endsWith(':generateContent')) {
      return { status: 404, body: { error: 'not found' } };
    }
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString('utf8')) as unknown;
    } catch {
      return { status: 599, body: { error: unknownScript, key: '' } };
    }
    const cued = cueResponse(body, scripts.cues);
    if (cued !== undefined) return { status: 200, body: cued };
    let key = '';
    try {
      key = canonicalPayloadSha256(body);
    } catch {
      return { status: 599, body: { error: unknownScript, key } };
    }
    const response = scripts.byHash.get(key);
    return response === undefined
      ? { status: 599, body: { error: unknownScript, key } }
      : { status: 200, body: response };
  };
}

function loadScripts(): { byHash: Map<string, unknown>; cues: readonly CueScript[] } {
  const byHash = new Map<string, unknown>();
  const cues: CueScript[] = [];
  addFixture(byHash, cues, readFileSync(claimsApprovalPath, 'utf8'));
  addFixture(byHash, cues, readFileSync(helloFixturePath, 'utf8'));
  addFixture(byHash, cues, readFileSync(hostileFollowPath, 'utf8'));
  addFixture(byHash, cues, readFileSync(loopingPath, 'utf8'));
  addFixture(byHash, cues, readFileSync(triageFixturePath, 'utf8'));
  addFixture(byHash, cues, readFileSync(triageSourceDataPath, 'utf8'));
  return { byHash, cues };
}

function addFixture(byHash: Map<string, unknown>, cues: CueScript[], source: string): void {
  const parsed = readFixture(source);
  if (parsed.request !== undefined)
    byHash.set(canonicalPayloadSha256(parsed.request), parsed.response);
  if (parsed.cue !== undefined) cues.push({ cue: parsed.cue, response: parsed.response });
}

type LoadedFixture = {
  response: unknown;
  request?: unknown;
  cue?: string;
};

function readFixture(source: string): LoadedFixture {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || !('response' in parsed)) throw new Error(badFixture);
  const request = 'request' in parsed ? parsed.request : undefined;
  const cue =
    'cue' in parsed && typeof parsed.cue === 'string' && parsed.cue.length > 0
      ? parsed.cue
      : undefined;
  if (request === undefined && cue === undefined) throw new Error(badFixture);
  return { request, cue, response: parsed.response };
}

function cueResponse(body: unknown, cues: readonly CueScript[]): unknown {
  const texts = textParts(body);
  return cues.find((script) => texts.some((text) => text.includes(script.cue)))?.response;
}

function textParts(body: unknown): readonly string[] {
  if (!isRecord(body) || !Array.isArray(body.contents)) return [];
  const texts: string[] = [];
  for (const content of body.contents) {
    if (!isRecord(content) || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
