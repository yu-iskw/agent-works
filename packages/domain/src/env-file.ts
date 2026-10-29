import { readFileSync } from 'node:fs';

/** `KEY=VALUE` lines; `#` comments and blank lines ignored; one pair of surrounding quotes stripped; no expansion. */
export function parseEnvFile(body: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(
      line.slice(0, eq).trim(),
      line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2'),
    );
  }
  return out;
}

/** The operator's mounted secrets file; a missing or unreadable file reads as empty, never as an error. */
export function readEnvFile(path: string | undefined): ReadonlyMap<string, string> {
  if (path === undefined || path.length === 0) return new Map();
  try {
    // Operator-configured mount path from the environment, never request controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}

/** Comma-separated list with blanks dropped. */
export function csvList(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
