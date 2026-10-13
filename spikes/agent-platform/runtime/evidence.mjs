import { sealTranscript, verifyTranscriptBytes } from '../../common/verify.mjs';
import { feature, requestShape, responseShape, expectedResponse } from './probe.mjs';

const maximumBytes = 64 * 1024;
const forbidden = [
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*(?!\[redacted\])\S+/i,
];

function failure(code) {
  // Never echo raw evidence, identifiers or exception messages.
  return { ok: false, reasons: [{ code }] };
}

export function checkFields(value, shape) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(shape).length) return false;
  return keys.every((key) => {
    const rule = shape[key];
    if (Array.isArray(rule)) return rule.includes(value[key]);
    if (rule === 'boolean') return typeof value[key] === 'boolean';
    if (rule === 'integer')
      return Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000;
    return false;
  });
}

function unpack(exchange, shape) {
  const fields = {};
  for (const item of exchange.observations) {
    if (Object.hasOwn(fields, item.name)) return null;
    Object.defineProperty(fields, item.name, { value: item.value, enumerable: true });
  }
  return checkFields(fields, shape) ? fields : null;
}

export function assess(request, response) {
  const expected = expectedResponse(request);
  const violations = Object.keys(expected).filter((key) => expected[key] !== response[key]);
  return {
    verdict: violations.length
      ? 'no-go'
      : expected.outcome === 'unavailable' ||
          (feature === 'memory' && !response['retention-demonstrated'])
        ? 'defer'
        : 'unverified',
    violations,
    expected,
  };
}

export function validateEvidence(bytes) {
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) return failure('input');
  if (Buffer.byteLength(bytes) > maximumBytes) return failure('size');
  const text = bytes.toString();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return failure('json');
  }
  // Scan decoded strings too: JSON escape sequences must not hide sensitive content.
  let decoded;
  try {
    decoded = JSON.stringify(envelope);
  } catch {
    return failure('nesting');
  }
  if (forbidden.some((pattern) => pattern.test(decoded))) return failure('sensitive-content');
  let common;
  try {
    common = verifyTranscriptBytes(bytes);
  } catch {
    return failure('verifier-error');
  }
  if (common.status !== 'passed')
    return { ok: false, reasons: common.reasons.map(({ code }) => ({ code })) };
  const transcript = envelope.transcript;
  if (
    transcript.feature !== feature ||
    transcript.spike !== 'C-02' ||
    transcript.region !== 'asia-northeast1' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(transcript.stage) ||
    transcript.id !== `c02.${feature}.${transcript.stage}` ||
    transcript.request.api !== `${feature}.evaluate` ||
    transcript.response.api !== `${feature}.evaluate` ||
    transcript.request.httpStatus !== null ||
    transcript.response.httpStatus !== null
  )
    return failure('probe-binding');
  // HTTP status is deliberately null: the offline adapter observes no HTTP exchange.
  const request = unpack(transcript.request, requestShape);
  const response = unpack(transcript.response, responseShape);
  if (!request || !response) return failure('fields');
  const assessment = assess(request, response);
  if (transcript.verdict === 'go') return failure('offline-go');
  if (assessment.verdict === 'no-go' && transcript.verdict !== 'no-go')
    return failure('hidden-control-failure');
  if (assessment.verdict === 'defer' && transcript.verdict !== 'defer')
    return failure('missing-deferral');
  if (assessment.verdict === 'unverified' && !['unverified', 'defer'].includes(transcript.verdict))
    return failure('unsupported-verdict');
  return {
    ok: true,
    transcript,
    request,
    response,
    assessment,
    liveValidation: 'UNVERIFIED',
    adoption: 'DEFER',
  };
}

export function makeEvidence(caseId, request, response) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseId)) throw new Error('Invalid case label');
  if (!checkFields(request, requestShape) || !checkFields(response, responseShape))
    throw new Error('Invalid adapter fields');
  const observations = (fields) => Object.entries(fields).map(([name, value]) => ({ name, value }));
  const requestObservations = observations(request);
  const redacted = requestObservations.flatMap((item, index) =>
    item.value === '[redacted]'
      ? [{ path: `/request/observations/${index}/value`, mark: '[redacted]' }]
      : [],
  );
  const transcript = {
    schemaId: 'agent-works.cloud-spike.transcript',
    schemaVersion: 1,
    id: `c02.${feature}.${caseId}`,
    // Fabricated fixture date, never a live observation date.
    capturedAt: '2000-01-01T00:00:00Z',
    region: 'asia-northeast1',
    spike: 'C-02',
    feature,
    stage: caseId,
    verdict: assess(request, response).verdict,
    provenance: { kind: 'synthetic' },
    request: { api: `${feature}.evaluate`, httpStatus: null, observations: requestObservations },
    response: {
      api: `${feature}.evaluate`,
      httpStatus: null,
      observations: observations(response),
    },
    redacted,
    omitted: [{ path: '/request/body' }, { path: '/response/body' }],
  };
  const sealed = sealTranscript(transcript);
  if (!sealed.ok) throw new Error('Evidence could not be sealed');
  const checked = validateEvidence(JSON.stringify(sealed.envelope));
  if (!checked.ok) throw new Error('Evidence rejected');
  return sealed.envelope;
}

export function recordedBackend(envelopes) {
  const records = new Map();
  for (const envelope of envelopes) {
    const checked = validateEvidence(JSON.stringify(envelope));
    if (!checked.ok) throw new Error('Invalid recorded evidence');
    const label = checked.transcript.stage;
    if (records.has(label)) throw new Error('Duplicate recorded case');
    records.set(label, checked);
  }
  return Object.freeze({
    async exchange(caseId, request) {
      const record = records.get(caseId);
      if (!record) throw new Error('Missing recorded case');
      if (!checkFields(request, requestShape)) throw new Error('Invalid request');
      if (Object.keys(requestShape).some((key) => request[key] !== record.request[key]))
        throw new Error('Recorded request mismatch');
      return structuredClone(record.response);
    },
  });
}

export async function runProbe(caseId, request, backend) {
  if (!checkFields(request, requestShape)) throw new Error('Invalid request');
  if (!backend || typeof backend.exchange !== 'function')
    throw new Error('Missing offline adapter');
  // No SDK, fetch, sockets, subprocess, environment credentials or persistence.
  const response = await backend.exchange(caseId, structuredClone(request));
  return makeEvidence(caseId, request, response);
}
