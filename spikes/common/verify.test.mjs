import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalPayloadSha256 } from '../../packages/domain/src/canonical-hash.ts';

import { sealTranscript, verifyCommitted, verifyTranscriptBytes } from './verify.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validPath = 'spikes/common/fixtures/valid/c02-runtime-sessions.transcript.json';
const alteredPath = 'spikes/common/fixtures/negative/altered-checksum.transcript.json';
const syntheticGoPath = 'spikes/common/fixtures/negative/synthetic-go.transcript.json';

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function withTemp(prefix, run) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function repoRelative(file) {
  return path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');
}

function regexLiterals(source, name) {
  const start = source.indexOf(`function ${name}`);
  const bodyStart = source.indexOf('return [', start);
  const bodyEnd = source.indexOf('];', bodyStart);
  const body = source.slice(bodyStart, bodyEnd);
  const literals = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '/' || body[index + 1] === '/' || body[index + 1] === '*') continue;
    const end = readRegexLiteral(body, index);
    if (end === null) continue;
    literals.push(body.slice(index, end));
    index = end - 1;
  }
  return literals;
}

function readRegexLiteral(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index += 1;
      while (index < source.length && /[dgimsuy]/.test(source[index])) index += 1;
      return index;
    }
    if (char === '\n') return null;
    index += 1;
  }
  return null;
}

test('valid fixture passes and seals to the same envelope', () => {
  const bytes = readFileSync(path.join(repoRoot, validPath));
  const envelope = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(verifyTranscriptBytes(bytes), {
    id: 'c02.runtime.sessions',
    status: 'passed',
    reasons: [],
  });
  assert.equal(envelope.digest, canonicalPayloadSha256(envelope.transcript));
  assert.deepEqual(sealTranscript(envelope.transcript), { ok: true, envelope });
});

test('altered checksum fails with checksum only', () => {
  assert.deepEqual(verifyTranscriptBytes(readFileSync(path.join(repoRoot, alteredPath))), {
    id: 'c02.runtime.sessions',
    status: 'failed',
    reasons: [{ code: 'checksum' }],
  });
});

test('synthetic go fails closed', () => {
  const envelope = readJson(syntheticGoPath);
  assert.deepEqual(verifyTranscriptBytes(readFileSync(path.join(repoRoot, syntheticGoPath))), {
    id: 'c02.runtime.synthetic-go',
    status: 'failed',
    reasons: [{ code: 'synthetic-go' }],
  });
  assert.deepEqual(sealTranscript(envelope.transcript), {
    ok: false,
    reasons: [{ code: 'synthetic-go' }],
  });
});

test('secret bodies are refused without echoing the token', () => {
  const bearer = ['Be', 'arer'].join('') + ' ' + 'synthetic1';
  const ya = ['ya', '29.'].join('') + 'synthetic1';
  const oauth = ['oa', 'uth_token'].join('') + '=' + 'synthetic1';
  const access = ['ac', 'cess_token'].join('') + '=' + 'synthetic1';
  const sk = ['s', 'k-'].join('') + 'synthetic1';
  const ghp = ['gh', 'p_'].join('') + 'synthetic1';
  const tokens = [bearer, ya, oauth, access, sk, ghp];
  const body = {
    schemaId: 'agent-works.cloud-spike.transcript',
    schemaVersion: 1,
    id: 'c02.runtime.secret-scan',
    capturedAt: '2026-10-13T00:00:00Z',
    region: 'asia-northeast1',
    spike: 'C-02',
    feature: 'agent-runtime',
    stage: 'sessions',
    verdict: 'unverified',
    provenance: { kind: 'synthetic' },
    request: { api: 'agentruntime.sessions.create', httpStatus: null, observations: [] },
    response: {
      api: 'agentruntime.sessions.create',
      httpStatus: null,
      observations: tokens.map((token, index) => ({ name: `field-${index}`, value: token })),
    },
    redacted: [],
    omitted: [{ path: '/response/body' }],
  };
  const reasons = [
    { code: 'secret', family: 'bearer', path: '/response/observations/0/value' },
    { code: 'secret', family: 'ya29', path: '/response/observations/1/value' },
    { code: 'secret', family: 'oauth-token', path: '/response/observations/2/value' },
    { code: 'secret', family: 'access-token', path: '/response/observations/3/value' },
    { code: 'secret', family: 'sk', path: '/response/observations/4/value' },
    { code: 'secret', family: 'ghp', path: '/response/observations/5/value' },
  ];
  const sealed = sealTranscript(body);
  assert.deepEqual(sealed, { ok: false, reasons });
  const envelope = { digest: '0'.repeat(64), transcript: body };
  const verified = verifyTranscriptBytes(JSON.stringify(envelope));
  assert.deepEqual(verified, { id: 'c02.runtime.secret-scan', status: 'failed', reasons });
  const encoded = JSON.stringify(sealed) + JSON.stringify(verified);
  for (const token of tokens) assert.equal(encoded.includes(token), false);
});

test('missing root is an empty pass', () => {
  assert.deepEqual(verifyCommitted(['spikes/does-not-exist']), {
    schemaId: 'agent-works.cloud-spike.verify-report',
    schemaVersion: 1,
    status: 'passed',
    results: [],
  });
});

test('unrelated json is ignored and an empty claimed file fails', () => {
  withTemp('spike-empty-', (directory) => {
    writeFileSync(path.join(directory, 'notes.json'), '{"note":"hello"}\n');
    writeFileSync(path.join(directory, 'broken.json'), '{');
    writeFileSync(path.join(directory, 'readme.txt'), 'hello\n');
    assert.deepEqual(verifyCommitted([directory]), {
      schemaId: 'agent-works.cloud-spike.verify-report',
      schemaVersion: 1,
      status: 'passed',
      results: [],
    });
  });
  withTemp('spike-claimed-', (directory) => {
    const file = path.join(directory, 'empty.transcript.json');
    writeFileSync(file, '{}\n');
    const relative = repoRelative(file);
    assert.deepEqual(verifyCommitted([directory]), {
      schemaId: 'agent-works.cloud-spike.verify-report',
      schemaVersion: 1,
      status: 'failed',
      results: [
        {
          id: `unreadable:${relative}`,
          status: 'failed',
          reasons: [{ code: 'schema' }],
        },
      ],
    });
  });
});

test('duplicate ids fail the report', () => {
  withTemp('spike-dup-', (directory) => {
    const bytes = readFileSync(path.join(repoRoot, validPath));
    writeFileSync(path.join(directory, 'a.transcript.json'), bytes);
    writeFileSync(path.join(directory, 'b.transcript.json'), bytes);
    assert.deepEqual(verifyCommitted([directory]), {
      schemaId: 'agent-works.cloud-spike.verify-report',
      schemaVersion: 1,
      status: 'failed',
      results: [
        {
          id: 'c02.runtime.sessions',
          status: 'failed',
          reasons: [{ code: 'duplicate-id' }],
        },
        {
          id: 'c02.runtime.sessions',
          status: 'failed',
          reasons: [{ code: 'duplicate-id' }],
        },
      ],
    });
  });
});

test('observation values stay out of the report', () => {
  withTemp('spike-value-', (directory) => {
    const envelope = readJson(validPath);
    const body = structuredClone(envelope.transcript);
    body.id = 'c02.runtime.observation';
    body.response.observations = [{ name: 'customer', value: 'customer-sentinel' }];
    body.redacted = [];
    const sealed = sealTranscript(body);
    assert.equal(sealed.ok, true);
    writeFileSync(
      path.join(directory, 'observation.transcript.json'),
      `${JSON.stringify(sealed.envelope, null, 2)}\n`,
    );
    const report = verifyCommitted([directory]);
    assert.deepEqual(report.results, [
      { id: 'c02.runtime.observation', status: 'passed', reasons: [] },
    ]);
    assert.equal(JSON.stringify(report).includes('customer-sentinel'), false);
  });
});

test('committed transcripts include the synthetic sessions fixture', () => {
  const report = verifyCommitted();
  assert.deepEqual(
    report.results.find((entry) => entry.id === 'c02.runtime.sessions'),
    { id: 'c02.runtime.sessions', status: 'passed', reasons: [] },
  );
});

test('secret pattern sources match the audit exporter', () => {
  const verifySource = readFileSync(path.join(repoRoot, 'spikes/common/verify.mjs'), 'utf8');
  const exporterSource = readFileSync(
    path.join(repoRoot, 'apps/api/src/audit/exporter.ts'),
    'utf8',
  );
  const verifyLiterals = regexLiterals(verifySource, 'secretPatterns');
  const exporterLiterals = regexLiterals(exporterSource, 'secretPatterns');
  assert.equal(verifyLiterals.length, 5);
  assert.deepEqual(verifyLiterals, exporterLiterals);
});

test('seal refuses a mismatched redaction and an unlisted mark', () => {
  const envelope = readJson(validPath);
  const mismatched = structuredClone(envelope.transcript);
  mismatched.response.observations[0].value = 'visible';
  assert.deepEqual(sealTranscript(mismatched), {
    ok: false,
    reasons: [{ code: 'redaction-mismatch', path: '/response/observations/0/value' }],
  });
  const unlisted = structuredClone(envelope.transcript);
  unlisted.redacted = [];
  assert.deepEqual(sealTranscript(unlisted), {
    ok: false,
    reasons: [{ code: 'redaction-mismatch', path: '/response/observations/0/value' }],
  });
});

test('an at-sign in the relative path is not stored', () => {
  withTemp('spike-@-', (directory) => {
    const file = path.join(directory, 'empty.transcript.json');
    writeFileSync(file, '{}\n');
    const relative = repoRelative(file);
    assert.equal(relative.includes('@'), true);
    const report = verifyCommitted([directory]);
    const id = `unreadable:${createHash('sha256').update(relative).digest('hex')}`;
    assert.deepEqual(report, {
      schemaId: 'agent-works.cloud-spike.verify-report',
      schemaVersion: 1,
      status: 'failed',
      results: [{ id, status: 'failed', reasons: [{ code: 'schema' }] }],
    });
    assert.equal(id.startsWith('unreadable:'), true);
    assert.equal(JSON.stringify(report).includes('@'), false);
  });
});
