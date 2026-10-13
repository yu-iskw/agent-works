import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  canonicalPayloadSha256,
  NonCanonicalPayload,
} from '../../packages/domain/src/canonical-hash.ts';

const transcriptSchemaId = 'agent-works.cloud-spike.transcript';
const reportSchemaId = 'agent-works.cloud-spike.verify-report';
const redactedMark = '[redacted]';
const spikePrefix = {
  'C-02': 'c02.',
  'C-03': 'c03.',
  'C-04': 'c04.',
};
const idPattern = new RegExp(
  `^(?:${Object.values(spikePrefix)
    .map((prefix) => prefix.slice(0, -1))
    .join('|')})(?:\\.[a-z0-9-]+)+$`,
);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const pointer = z.string().regex(/^(\/[A-Za-z0-9-]+)+$/);
const closedVerdicts = ['no-go', 'defer', 'defer/unavailable', 'unverified'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRoots = [
  'spikes/common/fixtures/valid',
  'docs/spikes',
  'spikes/iap',
  'spikes/agent-platform',
  'spikes/retrieval',
];

const observationValue = z.union([
  z.string().max(500),
  z
    .number()
    .finite()
    .refine((value) => !Object.is(value, -0)),
  z.boolean(),
  z.null(),
]);

const exchangeSchema = z.strictObject({
  api: z
    .string()
    .regex(/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/)
    .max(120),
  httpStatus: z.union([z.null(), z.number().int().min(100).max(599)]),
  observations: z
    .array(
      z.strictObject({
        name: slug,
        value: observationValue,
      }),
    )
    .max(32),
});

function isCapturedAt(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000Z', 'Z') === value;
}

const transcriptFields = {
  schemaId: z.literal(transcriptSchemaId),
  schemaVersion: z.literal(1),
  id: z.string().regex(idPattern),
  capturedAt: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/)
    .refine(isCapturedAt),
  region: z.string().regex(/^[a-z][a-z0-9-]{1,30}[0-9]$/),
  spike: z.enum(Object.keys(spikePrefix)),
  feature: slug,
  stage: slug,
  request: exchangeSchema,
  response: exchangeSchema,
  redacted: z
    .array(
      z.strictObject({
        path: pointer,
        mark: z.literal(redactedMark),
      }),
    )
    .max(32),
  omitted: z
    .array(
      z.strictObject({
        path: pointer,
      }),
    )
    .max(32),
};

const transcriptSchema = z.strictObject({
  ...transcriptFields,
  verdict: z.enum([...closedVerdicts, 'go']),
  provenance: z.strictObject({ kind: z.enum(['synthetic', 'observed']) }),
});

function secretScans() {
  return [
    {
      families: ['bearer'],
      pattern: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    },
    {
      families: ['ya29'],
      pattern: /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9._-]+/g,
    },
    {
      families: ['oauth-token', 'access-token'],
      pattern:
        /(?<![A-Za-z0-9])(?:oauth_token|access_token)(?:"\s*:\s*"[^"]*"|\s*[:=]\s*\S+|\s*%3D\S+)/gi,
    },
    {
      families: ['sk'],
      pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
    },
    {
      families: ['ghp'],
      pattern: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{8,}/g,
    },
  ];
}

const secretFamilyOrder = secretScans().flatMap((scan) => scan.families);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf16(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function row(id, reasons) {
  return { id, status: reasons.length === 0 ? 'passed' : 'failed', reasons };
}

function matchingId(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !idPattern.test(value.id))
    return null;
  return value.id;
}

function readId(value) {
  const id = matchingId(value);
  if (id === null || scanSecrets(id).length === 0) return id;
  return `unreadable:${createHash('sha256').update(id).digest('hex')}`;
}

function isEnvelope(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.every((key) => key === 'digest' || key === 'transcript');
}

function familyOf(scan, match) {
  if (scan.families.length === 1) return scan.families[0];
  const lower = match.toLowerCase();
  if (lower.startsWith('oauth_token')) return 'oauth-token';
  if (lower.startsWith('access_token')) return 'access-token';
  return null;
}

function scanSecrets(text) {
  const hits = [];
  for (const scan of secretScans()) {
    const { pattern } = scan;
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const expression = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(expression)) {
      const family = familyOf(scan, match[0]);
      if (family) hits.push({ family, match: match[0] });
    }
  }
  return hits;
}

function encodePointerToken(token) {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerForSecret(pointerText) {
  if (scanSecrets(pointerText).length > 0) return null;
  return pointerText;
}

function rawMatchExtendsLocatedSecret(covered, match) {
  for (const seen of covered) {
    if (seen === match || match.includes(seen) || seen.includes(match)) return true;
  }
  return false;
}

function secretReasons(rawText, value) {
  const hits = [];
  const covered = new Set();
  const add = (family, secretPath, match) => {
    covered.add(match);
    hits.push({ family, path: secretPath });
  };
  if (value !== undefined) collectValueSecrets(value, '', add);
  if (typeof rawText === 'string') {
    for (const hit of scanSecrets(rawText)) {
      if (rawMatchExtendsLocatedSecret(covered, hit.match)) continue;
      add(hit.family, null, hit.match);
    }
  }
  return dedupeSecretReasons(hits);
}

function prefixSecretPath(key, path) {
  if (path === null) return null;
  return pointerForSecret(`/${encodePointerToken(key)}${path}`);
}

function decodedSecretReasons(rawText, value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'transcript'))
    return secretReasons(rawText, value);
  const reasons = secretReasons(rawText, value.transcript);
  const extras = [];
  for (const key of Object.keys(value)) {
    if (key === 'transcript') continue;
    for (const reason of secretReasons(undefined, value[key])) {
      extras.push({ ...reason, path: prefixSecretPath(key, reason.path) });
    }
  }
  if (extras.length === 0) return reasons;
  return dedupeSecretReasons([...reasons, ...extras]);
}

function collectValueSecrets(value, pointerText, add) {
  if (typeof value === 'string') {
    for (const hit of scanSecrets(value)) add(hit.family, pointerForSecret(pointerText), hit.match);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectValueSecrets(value[index], `${pointerText}/${index}`, add);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const child = `${pointerText}/${encodePointerToken(key)}`;
    for (const hit of scanSecrets(key)) add(hit.family, null, hit.match);
    collectValueSecrets(value[key], child, add);
  }
}

function dedupeSecretReasons(hits) {
  const seen = new Set();
  const reasons = [];
  for (const hit of hits) {
    const key = `${hit.family}\0${hit.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ code: 'secret', family: hit.family, path: hit.path });
  }
  reasons.sort((left, right) => {
    const byFamily =
      secretFamilyOrder.indexOf(left.family) - secretFamilyOrder.indexOf(right.family);
    if (byFamily !== 0) return byFamily;
    return compareUtf16(left.path ?? '', right.path ?? '');
  });
  return reasons;
}

function digestOrReason(transcript) {
  try {
    return { digest: canonicalPayloadSha256(transcript) };
  } catch (error) {
    if (error instanceof NonCanonicalPayload) return { reasons: [{ code: 'non-canonical' }] };
    return { reasons: [{ code: 'verifier-error' }] };
  }
}

function checksumReasons(digest, transcript) {
  const checked = digestOrReason(transcript);
  if (checked.reasons) return checked.reasons;
  if (digest !== checked.digest) return [{ code: 'checksum' }];
  return [];
}

function idMatchesSpike(id, spike) {
  const prefix = spikePrefix[spike];
  return typeof prefix === 'string' && id.startsWith(prefix);
}

function idSpikeMismatch(value) {
  const id = matchingId(value);
  if (id === null || !Object.hasOwn(spikePrefix, value.spike)) return false;
  return !idMatchesSpike(id, value.spike);
}

function isSyntheticGo(value) {
  return (
    isPlainObject(value) &&
    value.verdict === 'go' &&
    isPlainObject(value.provenance) &&
    value.provenance.kind === 'synthetic'
  );
}

function parseReasons(value) {
  const parsed = transcriptSchema.safeParse(value);
  if (!parsed.success) return failureReasons(value);
  if (isSyntheticGo(parsed.data)) {
    const reasons = [{ code: 'synthetic-go' }];
    if (!idMatchesSpike(parsed.data.id, parsed.data.spike)) reasons.push({ code: 'id-spike' });
    return reasons;
  }
  if (!idMatchesSpike(parsed.data.id, parsed.data.spike)) return [{ code: 'id-spike' }];
  return contentReasons(parsed.data);
}

function failureReasons(value) {
  const reasons = [];
  if (isSyntheticGo(value)) reasons.push({ code: 'synthetic-go' });
  if (idSpikeMismatch(value)) reasons.push({ code: 'id-spike' });
  reasons.push({ code: 'schema' });
  return reasons;
}

function contentReasons(transcript) {
  const reasons = [];
  const listed = new Set(transcript.redacted.map((item) => item.path));
  for (const item of transcript.redacted) {
    const found = readPointer(transcript, item.path);
    if (!found || found.value !== redactedMark) {
      reasons.push({ code: 'redaction-mismatch', path: pointerForSecret(item.path) });
    }
  }
  for (const redactedPath of redactedStrings(transcript)) {
    if (!listed.has(redactedPath)) {
      reasons.push({ code: 'redaction-mismatch', path: pointerForSecret(redactedPath) });
    }
  }
  for (const item of transcript.omitted) {
    if (readPointer(transcript, item.path)) {
      reasons.push({ code: 'omission-mismatch', path: pointerForSecret(item.path) });
    }
  }
  return reasons;
}

function readPointer(root, pointerText) {
  const tokens = pointerText.split('/').slice(1);
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return null;
      const index = Number(token);
      if (index >= current.length || !Object.hasOwn(current, index)) return null;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, token)) return null;
    current = current[token];
  }
  return { value: current };
}

function redactedStrings(value) {
  const found = [];
  collectRedactedStrings(value, '', found);
  return found;
}

function isDeclaredRedactionMark(pointerText, key) {
  return key === 'mark' && /^\/redacted\/[0-9]+$/.test(pointerText);
}

function collectRedactedStrings(value, pointerText, found) {
  if (typeof value === 'string') {
    if (value === redactedMark) found.push(pointerText);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectRedactedStrings(value[index], `${pointerText}/${index}`, found);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (isDeclaredRedactionMark(pointerText, key)) continue;
    collectRedactedStrings(value[key], `${pointerText}/${key}`, found);
  }
}

function rawTextOf(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

function withChecksumUnlessSecret(reasons, digestCheck, transcript) {
  if (!digestCheck || reasons.some((reason) => reason.code === 'secret')) return reasons;
  return [...reasons, ...checksumReasons(digestCheck.digest, transcript)];
}

function assessTranscript(transcript, rawText, digestCheck, decoded) {
  const secrets =
    decoded === undefined
      ? secretReasons(rawText, transcript)
      : decodedSecretReasons(rawText, decoded);
  const reasons = withChecksumUnlessSecret(secrets, digestCheck, transcript);
  reasons.push(...parseReasons(transcript));
  return reasons;
}

export function sealTranscript(input) {
  const reasons = assessTranscript(input, rawTextOf(input), null);
  if (reasons.length > 0) return { ok: false, reasons };
  const checked = digestOrReason(input);
  if (checked.reasons) return { ok: false, reasons: checked.reasons };
  return { ok: true, envelope: { digest: checked.digest, transcript: input } };
}

export function verifyTranscriptBytes(bytes) {
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) {
    return row(null, [{ code: 'verifier-error' }]);
  }
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return row(null, [...secretReasons(text, undefined), { code: 'json' }]);
  }
  if (!isEnvelope(value)) {
    const transcript = isPlainObject(value) ? value.transcript : undefined;
    return row(readId(transcript), [...decodedSecretReasons(text, value), { code: 'schema' }]);
  }
  return row(
    readId(value.transcript),
    assessTranscript(value.transcript, text, { digest: value.digest }, value),
  );
}

function repoRelative(file) {
  return path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');
}

function fallbackId(file) {
  const relative = repoRelative(file);
  if (relative.includes('@') || scanSecrets(relative).length > 0) {
    return `unreadable:${createHash('sha256').update(relative).digest('hex')}`;
  }
  return `unreadable:${relative}`;
}

function scanRootStat(file) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

function listFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (
        entry.isFile() ||
        (entry.isSymbolicLink() && entry.name.endsWith('.transcript.json'))
      )
        files.push(full);
    }
  };
  visit(directory);
  return files;
}

function carriesTranscriptSchema(value) {
  if (!isPlainObject(value)) return false;
  if (value.schemaId === transcriptSchemaId) return true;
  return isPlainObject(value.transcript) && value.transcript.schemaId === transcriptSchemaId;
}

function isClaimed(file) {
  const base = path.basename(file);
  if (base.endsWith('.transcript.json')) return true;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    return carriesTranscriptSchema(JSON.parse(text));
  } catch {
    return false;
  }
}

function verifyFile(file) {
  let bytes;
  try {
    if (lstatSync(file).isSymbolicLink()) {
      return row(fallbackId(file), [{ code: 'verifier-error' }]);
    }
    bytes = readFileSync(file);
  } catch {
    return row(fallbackId(file), [{ code: 'verifier-error' }]);
  }
  const checked = verifyTranscriptBytes(bytes);
  return row(checked.id ?? fallbackId(file), checked.reasons);
}

function applyDuplicates(rows) {
  const counts = new Map();
  for (const entry of rows) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  return rows.map((entry) => {
    if (counts.get(entry.id) < 2) return entry;
    return row(entry.id, [...entry.reasons, { code: 'duplicate-id' }]);
  });
}

export function verifyCommitted(roots = defaultRoots) {
  const files = [];
  const rootResults = [];
  for (const root of roots) {
    const directory = path.resolve(repoRoot, root);
    const stat = scanRootStat(directory);
    if (stat?.isSymbolicLink()) {
      rootResults.push(row(fallbackId(directory), [{ code: 'verifier-error' }]));
      continue;
    }
    if (!stat?.isDirectory()) continue;
    files.push(...listFiles(directory).filter((file) => isClaimed(file)));
  }
  files.sort((left, right) => compareUtf16(repoRelative(left), repoRelative(right)));
  const results = applyDuplicates([...rootResults, ...files.map((file) => verifyFile(file))]);
  results.sort((left, right) => compareUtf16(left.id, right.id));
  return {
    schemaId: reportSchemaId,
    schemaVersion: 1,
    status: results.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    results,
  };
}

function writeAtomic(destination, text) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, destination);
}

function writeSafeReasons(reasons) {
  if (reasons.some((reason) => reason.code === 'secret')) return;
  for (const reason of reasons) process.stderr.write(`${JSON.stringify(reason)}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { mode: 'report', reportPath: null };
  const known = new Set(['--seal', '--out', '--file', '--report']);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!known.has(flag)) return null;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    index += 1;
    if (Object.hasOwn(values, flag)) return null;
    values[flag] = value;
  }
  const flags = Object.keys(values);
  if (flags.length === 1 && values['--report'])
    return { mode: 'report', reportPath: values['--report'] };
  if (flags.length === 1 && values['--file']) return { mode: 'file', filePath: values['--file'] };
  if (values['--seal'] && flags.every((flag) => flag === '--seal' || flag === '--out')) {
    return { mode: 'seal', sealPath: values['--seal'], outPath: values['--out'] ?? null };
  }
  return null;
}

function runSeal(sealPath, outPath) {
  let text;
  try {
    text = readFileSync(sealPath, 'utf8');
  } catch {
    process.exitCode = 1;
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    process.exitCode = 1;
    return;
  }
  const sealed = sealTranscript(body);
  if (!sealed.ok) {
    writeSafeReasons(sealed.reasons);
    process.exitCode = 1;
    return;
  }
  const pretty = `${JSON.stringify(sealed.envelope, null, 2)}\n`;
  if (!outPath) {
    process.stdout.write(pretty);
    return;
  }
  try {
    writeAtomic(outPath, pretty);
  } catch {
    process.exitCode = 1;
  }
}

function runFile(filePath) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    process.exitCode = 1;
    return;
  }
  const checked = verifyTranscriptBytes(bytes);
  const id = checked.id ?? fallbackId(filePath);
  process.stdout.write(`${id}: ${checked.status}\n`);
  writeSafeReasons(checked.reasons);
  if (checked.status === 'failed') process.exitCode = 1;
}

function runReport(reportPath) {
  const report = verifyCommitted();
  if (reportPath) {
    try {
      writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      process.exitCode = 1;
      return;
    }
  }
  for (const entry of report.results) process.stdout.write(`${entry.id}: ${entry.status}\n`);
  writeSafeReasons(report.results.flatMap((entry) => entry.reasons));
  if (report.status === 'failed') process.exitCode = 1;
}

function main() {
  try {
    const command = parseArgs(process.argv);
    if (!command) {
      process.stderr.write('usage\n');
      process.exitCode = 1;
      return;
    }
    if (command.mode === 'seal') runSeal(command.sealPath, command.outPath);
    else if (command.mode === 'file') runFile(command.filePath);
    else runReport(command.reportPath);
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
