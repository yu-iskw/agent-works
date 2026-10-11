import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { approvalDecideSchema, ticketCreateManifest, toolManifestSchema } from './broker.js';

import type { JSONSchema } from 'zod/v4/core';

const digest = 'a'.repeat(64);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function isJsonSchema(value: unknown): value is JSONSchema.JSONSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('broker contracts', () => {
  it('rejects an approval decision that omits the payload hash', () => {
    expect(approvalDecideSchema.safeParse({ decision: 'approve' }).success).toBe(false);
  });

  it('accepts a decision bound to a payload hash', () => {
    expect(
      approvalDecideSchema.parse({
        decision: 'approve',
        expectedPayloadSha256: digest,
      }),
    ).toEqual({
      decision: 'approve',
      expectedPayloadSha256: digest,
    });
  });

  it('accepts the ticket.create manifest', () => {
    expect(toolManifestSchema.parse(ticketCreateManifest)).toEqual(ticketCreateManifest);
  });

  it('validates ticket.create input with the schema the manifest names', () => {
    expect(ticketCreateManifest.spec.inputSchemaRef).toBe('schemas/ticket-create.json');
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, 'schemas/ticket-create.json'), 'utf8'),
    );
    if (!isJsonSchema(parsed)) throw new Error('ticket create schema');
    const schema = z.fromJSONSchema(parsed);
    expect(schema.parse({ summary: 'Checkout latency', project: 'ops' })).toEqual({
      summary: 'Checkout latency',
      project: 'ops',
    });
    expect(schema.safeParse({ summary: 'Checkout latency' }).success).toBe(false);
    expect(schema.safeParse({ summary: '', project: 'ops' }).success).toBe(false);
    expect(
      schema.safeParse({ summary: 'Checkout latency', project: 'ops', note: 'x' }).success,
    ).toBe(false);
  });
});
