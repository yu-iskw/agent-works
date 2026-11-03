const REDACTED = '[REDACTED]';

const sensitiveKey =
  /token|secret|passw|authorization|cookie|assertion|api[-_]?key|credential|prompt|source|body|content|text|args|arguments|input|objective|private|signature/i;
const sensitiveValue = [
  /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g,
  /\bBearer\s+[\w.~+/=-]{8,}/gi,
  /\b(?:sk|ghp|gho|xox[abp])[-_][\w-]{12,}/g,
];
const maxDepth = 6;

/** Deny by default: values under sensitive keys are dropped, and credential shapes are scrubbed from every string. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (depth >= maxDepth) return REDACTED;
  if (value instanceof Error) return { error: value.name };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redact(item, depth + 1),
      ]),
    );
  return REDACTED;
}

function scrub(text: string): string {
  return sensitiveValue.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
}
