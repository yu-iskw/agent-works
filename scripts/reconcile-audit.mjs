import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const spanNames = ['web', 'api', 'runner', 'retrieval'];

export function spansFromOtlp(text) {
  const spans = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    const found = spansIn(parsed);
    if (found === undefined) return undefined;
    spans.push(...found);
  }
  return spans;
}

export function tracePropagated(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return false;
  const groups = new Map();
  for (const span of spans) {
    const group = groups.get(span.traceId);
    if (group === undefined) groups.set(span.traceId, [span]);
    else group.push(span);
  }
  for (const group of groups.values()) {
    if (!oneTrace(group)) return false;
  }
  return true;
}

function oneTrace(spans) {
  if (spans.length !== spanNames.length) return false;
  const byName = new Map(spans.map((span) => [span.name, span]));
  const web = byName.get('web');
  const api = byName.get('api');
  const runner = byName.get('runner');
  const retrieval = byName.get('retrieval');
  if (web === undefined || api === undefined || runner === undefined || retrieval === undefined) {
    return false;
  }
  if (!isHex(web.traceId, 32) || spans.some((span) => span.traceId !== web.traceId)) return false;
  if (![web, api, runner, retrieval].every((span) => isHex(span.spanId, 16))) return false;
  return (
    web.parentSpanId === null &&
    api.parentSpanId === web.spanId &&
    runner.parentSpanId === api.spanId &&
    retrieval.parentSpanId === api.spanId
  );
}

function spansIn(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.resourceSpans)) {
    return undefined;
  }
  const spans = [];
  for (const resource of value.resourceSpans) {
    if (resource === null || typeof resource !== 'object' || !Array.isArray(resource.scopeSpans)) {
      return undefined;
    }
    for (const scope of resource.scopeSpans) {
      if (scope === null || typeof scope !== 'object' || !Array.isArray(scope.spans))
        return undefined;
      for (const span of scope.spans) {
        const normalized = normalize(span);
        if (normalized === undefined) return undefined;
        spans.push(normalized);
      }
    }
  }
  return spans;
}

function normalize(span) {
  if (span === null || typeof span !== 'object') return undefined;
  const { name, traceId, spanId } = span;
  if (typeof name !== 'string' || typeof traceId !== 'string' || typeof spanId !== 'string') {
    return undefined;
  }
  const parent = span.parentSpanId ?? '';
  if (typeof parent !== 'string') return undefined;
  return {
    name,
    traceId,
    spanId,
    parentSpanId: parent === '' ? null : parent,
  };
}

function isHex(value, length) {
  return (
    typeof value === 'string' &&
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    !/^0+$/.test(value)
  );
}

function readInput() {
  const spansPath = process.argv[2];
  if (spansPath === undefined) {
    if (process.stdin.isTTY === true) {
      process.stderr.write('usage: reconcile-audit.mjs <spans.jsonl>\n');
      process.exitCode = 1;
      return undefined;
    }
    return readFileSync(0, 'utf8');
  }
  try {
    return readFileSync(spansPath, 'utf8');
  } catch {
    process.stderr.write('unreadable spans\n');
    process.exitCode = 1;
    return undefined;
  }
}

function main() {
  const text = readInput();
  if (text === undefined) return;
  const spans = spansFromOtlp(text);
  if (spans === undefined || !tracePropagated(spans)) {
    process.stderr.write('trace diverged\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('trace propagated\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
