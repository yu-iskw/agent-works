// @ts-check

import { query } from '../compare/matrix.mjs';
import { caseSchema } from '../compare/schema.mjs';
import { managedRecordingSchema } from './schema.mjs';
/** Preserve every recorded surface in responseText before extracting hits. No live client,
 * guessed userInfo.userId identity binding, credential fallback, or simulated live PASS. */
/**
 * @param {unknown} input
 */
export function replayManaged(input) {
  const recording = managedRecordingSchema.parse(input);
  const status =
    recording.status === 200
      ? 'ok'
      : recording.status === 403
        ? 'permission-denied'
        : 'unavailable';
  const results = recording.response.results ?? [];
  if (status !== 'ok' && results.length > 0)
    throw new Error('denied managed response contains results');
  const hits = results.map(({ document }) => ({
    sourceObjectId: document.id,
    title: document.structData.title,
    snippet: document.derivedStructData.snippets.map((entry) => entry.snippet).join('\n'),
    content: document.structData.content,
    provenance: {
      sourceUri: document.structData.sourceUri,
      version: document.structData.version,
      retrievedAt: document.structData.retrievedAt,
      accessDecisionId: document.structData.accessDecisionId,
      subject: recording.subject,
      sourceAccessChecked: document.structData.sourceAccessChecked,
    },
  }));
  return caseSchema.parse({
    id: recording.caseId,
    subject: recording.subject,
    query,
    status,
    httpStatus: recording.status,
    responseText: JSON.stringify(recording.response),
    hits,
    latencyMs: null,
    changedAt: null,
    checkedAt: null,
    revocationLagMs: null,
  });
}
