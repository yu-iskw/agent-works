import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';
import * as z from 'zod';

import { capabilityVersionCommandSchema, capabilityVersionSchema } from './capability-version.js';
import { suspensionAuditSchema, suspensionSnapshotSchema } from './suspension-api.js';
import { suspensionCommandSchema, suspensionSchema, suspensionTargetSchema } from './suspension.js';

const contracts = [
  { name: 'suspension-target', schema: suspensionTargetSchema },
  { name: 'suspension-command', schema: suspensionCommandSchema },
  { name: 'suspension-record', schema: suspensionSchema },
  { name: 'capability-version-command', schema: capabilityVersionCommandSchema },
  { name: 'capability-version-record', schema: capabilityVersionSchema },
  { name: 'suspension-audit', schema: suspensionAuditSchema },
  { name: 'suspension-snapshot', schema: suspensionSnapshotSchema },
];
test.each(contracts)(
  '$name published JSON contract matches the runtime schema',
  ({ name, schema }) => {
    const documented: unknown = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed schema names in the contract table
      readFileSync(new URL(`../../../docs/admin/schemas/${name}.json`, import.meta.url), 'utf8'),
    );
    expect(documented).toEqual(z.toJSONSchema(schema, { target: 'draft-2020-12' }));
  },
);
test.each(
  contracts.flatMap((contract) => [null, [], '', 1, true].map((value) => ({ ...contract, value }))),
)('$name rejects a non-object contract value', ({ schema, value }) => {
  expect(schema.safeParse(value).success).toBe(false);
});
test('audit payload accepts JSON details and covers denial correlation', () => {
  const event = suspensionAuditSchema.parse({
    eventId: 'event',
    eventType: 'invocation.denied',
    actorSub: 'alice',
    occurredAt: '2026-10-14T10:00:00.000Z',
    reason: 'CAPABILITY_VERSION_REVOKED',
    digest: 'a'.repeat(64),
    taskId: 'task',
    traceId: 'trace',
    details: { kind: 'model', pin: { id: 'incident', version: '1' } },
  });
  expect(event).toMatchObject({
    taskId: 'task',
    traceId: 'trace',
    reason: 'CAPABILITY_VERSION_REVOKED',
  });
  expect(suspensionAuditSchema.safeParse({ ...event, digest: 'not a digest' }).success).toBe(false);
  expect(suspensionAuditSchema.safeParse({ ...event, details: () => 'code' }).success).toBe(false);
});
