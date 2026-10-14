import { readFileSync } from 'node:fs';

import * as z from 'zod';

const caseSchema = z.fromJSONSchema(
  JSON.parse(readFileSync(new URL('../../evals/v1/case.schema.json', import.meta.url), 'utf8')),
);
const observationSchema = z.fromJSONSchema(
  JSON.parse(
    readFileSync(new URL('../../evals/v1/observation.schema.json', import.meta.url), 'utf8'),
  ),
);

/** Reject malformed input before computing denominators or rendering evidence. */
export function validateCase(value) {
  const row = caseSchema.parse(value);
  if (!row.id.startsWith(`${row.split}-`)) throw new Error('case ID split mismatch');
  const ids = row.documents.map((doc) => doc.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate document ID');
  for (const id of [...row.expected.relevantSourceIds, ...row.expected.supportedSourceIds]) {
    if (!ids.includes(id)) throw new Error('answer key references unknown source');
  }
  const visible = new Set(
    row.documents
      .filter(
        (doc) =>
          doc.folder === 'public' ||
          doc.folder === row.principal.subject ||
          row.principal.groups.includes(doc.folder),
      )
      .map((doc) => doc.id),
  );
  if (row.expected.supportedSourceIds.some((id) => !visible.has(id)))
    throw new Error('answer key authorizes inaccessible source');
  if (row.expected.status === 'answered' && row.expected.supportedSourceIds.length === 0)
    throw new Error('answered key needs authoritative support');
  if (row.scenario === 'memory-deletion' && row.expected.status !== 'deferred')
    throw new Error('P4-MEM remains deferred');
  return row;
}

export function validateObservation(value) {
  return observationSchema.parse(value);
}
