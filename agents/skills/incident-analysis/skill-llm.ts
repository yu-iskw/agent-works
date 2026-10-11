import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'llm/summarize.json');
const unknownScript = 'unknown script';

type Script = {
  readonly cue: string;
  readonly response: unknown;
};

export function createSkillLlm(): (request: { method: string; url: URL; body: Buffer }) => {
  status: number;
  body: unknown;
} {
  const script = loadScript(readFileSync(scriptPath, 'utf8'));
  return (request) => {
    if (request.method !== 'POST' || !request.url.pathname.endsWith(':generateContent')) {
      return { status: 404, body: { error: 'not found' } };
    }
    const body = parseJson(request.body.toString('utf8'));
    if (body === undefined) return { status: 599, body: { error: unknownScript } };
    const matched = textParts(body).some((text) => text.includes(script.cue));
    return matched
      ? { status: 200, body: script.response }
      : { status: 599, body: { error: unknownScript } };
  };
}

function loadScript(source: string): Script {
  const parsed = parseJson(source);
  if (!isRecord(parsed) || typeof parsed.cue !== 'string' || parsed.cue.length === 0) {
    throw new Error('llm fixture');
  }
  if (!('response' in parsed)) throw new Error('llm fixture');
  return { cue: parsed.cue, response: parsed.response };
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
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
