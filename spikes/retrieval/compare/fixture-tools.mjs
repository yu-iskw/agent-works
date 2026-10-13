// @ts-check
/** @typedef {import('./schema.mjs').RetrievalEvidence} RetrievalEvidence */
import { readFileSync } from 'node:fs';
import { canonicalPayloadSha256 } from '../../../packages/domain/src/canonical-hash.ts';
import { sealTranscript } from '../../common/verify.mjs';
import { evidenceSchema, sealEvidence, transcriptVerdict } from './schema.mjs';
/**
 * @param {URL} url
 * @returns {unknown}
 */
export function readJson(url) {
  // Fixed fixtures or explicit operator-local evidence paths, never HTTP request input.
  return /** @type {unknown} */ (JSON.parse(readFileSync(url, 'utf8')));
}
/** Also used by operators after sanitization. No evidence capture or live claims here. */
/**
 * @param {unknown} input
 */
export function bindEvidence(input) {
  const evidence = evidenceSchema.parse(input);
  const digest = canonicalPayloadSha256(evidence);
  const transcript = {
    schemaId: 'agent-works.cloud-spike.transcript',
    schemaVersion: 1,
    id: `c04.${evidence.arm === 'A' ? 'managed' : 'drive'}.offline`,
    capturedAt: evidence.capturedAt.replace('.000Z', 'Z'),
    region: evidence.region,
    spike: 'C-04',
    feature: evidence.service,
    stage: 'acl-matrix',
    request: {
      api: evidence.arm === 'A' ? 'discoveryengine.search' : 'drive.files',
      httpStatus: null,
      observations: [],
    },
    response: {
      api: evidence.arm === 'A' ? 'discoveryengine.search' : 'drive.files',
      httpStatus: null,
      observations: [
        { name: 'evidence-sha256', value: digest },
        { name: 'live-probed', value: evidence.provenance === 'observed' },
      ],
    },
    verdict: transcriptVerdict(evidence.verdict),
    provenance: { kind: evidence.provenance },
    redacted: [],
    omitted: [{ path: '/request/headers' }, { path: '/request/identities' }],
  };
  const sealed = sealTranscript(transcript);
  if (!sealed.ok) throw new Error('cannot bind invalid transcript');
  return sealEvidence(evidence, sealed.envelope);
}
/**
 * @param {'A' | 'B'} arm
 * @returns {RetrievalEvidence}
 */
export function baseline(arm) {
  return {
    schemaId: 'agent-works.retrieval.evidence',
    schemaVersion: 1,
    matrixId: 'bundle-b-acl-v1',
    arm,
    service: arm === 'A' ? 'gemini-enterprise' : 'drive-delegated',
    provenance: 'synthetic',
    verdict: arm === 'A' ? 'DEFER' : 'UNVERIFIED',
    availability: arm === 'A' ? 'unavailable' : 'not-probed',
    capturedAt: '2026-10-13T00:00:00Z',
    region: 'asia-northeast1',
    featureScope:
      arm === 'A'
        ? 'Document search, snippets, answer and extra response surfaces; no trial access'
        : 'Drive v3 files.list, files.get metadata/media, Google Docs text export; offline only',
    configuration: {
      sourceAclMode: 'unverified',
      identityMapping: 'unverified',
      featureStage: 'operator-gated',
    },
    reason:
      arm === 'A'
        ? 'DEFER/unavailable: no Gemini Enterprise trial evidence supplied'
        : 'UNVERIFIED: no live caller-delegated Drive evidence supplied',
    costUsd: null,
    cases: [],
    omitted: ['credentials', 'real-subjects', 'customer-content'],
  };
}
