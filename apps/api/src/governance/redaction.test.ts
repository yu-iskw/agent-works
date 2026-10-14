import { readFileSync } from 'node:fs';

import { governanceClassificationSchema } from '@agent-works/domain/data-governance';
import { describe, expect, it } from 'vitest';

import {
  governanceSiemMarker,
  redactClassifiedPayload,
} from '../audit/siem-export/redact-governance.js';

import { requestDeletion } from './deletion-requests.js';
import { classifiedTaskEvent, exportGovernanceMarkers } from './events.js';
import { CREATED, governanceFixture, REQUEST_ID, SECRET } from './test-fixtures.js';

import type { GovernanceClassification } from '@agent-works/domain/data-governance';

type Golden = {
  id: string;
  classification: GovernanceClassification;
  input: unknown;
  expected: unknown;
};

const golden = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository fixture
  readFileSync(new URL('./fixtures/redaction-golden.json', import.meta.url), 'utf8'),
) as Golden[];
describe('classification-aware redaction golden contract', () => {
  it.each(golden)('$id', (fixture) => {
    const label = governanceClassificationSchema.parse(fixture.classification);
    expect(redactClassifiedPayload(fixture.input, label)).toEqual(fixture.expected);
    expect(classifiedTaskEvent('task-1', fixture.input, label)).toEqual({
      taskId: 'task-1',
      classification: label,
      payload: fixture.expected,
    });
  });
  it('RESTRICTED root classification masks all nested values and keys', () => {
    const payload = { [SECRET]: SECRET, labels: [{ classification: 'PUBLIC', value: SECRET }] };
    expect(redactClassifiedPayload(payload, 'RESTRICTED')).toBe('[RESTRICTED]');
    expect(JSON.stringify(classifiedTaskEvent('task-1', payload, 'RESTRICTED'))).not.toContain(
      SECRET,
    );
  });
  it('never trusts a malformed explicit nested classification', () => {
    for (const classification of [false, null, 1, {}, [], 'restricted'])
      expect(redactClassifiedPayload({ classification, value: SECRET }, 'PUBLIC')).toBe(
        '[RESTRICTED]',
      );
  });
  it('drops prototype pollution keys without altering Object.prototype', () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"secret","prototype":"secret","ok":"safe"}',
    );
    expect(redactClassifiedPayload(input, 'PUBLIC')).toEqual({ ok: 'safe' });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('limits deeply nested arbitrary payloads', () => {
    let input: unknown = SECRET;
    for (let index = 0; index < 40; index += 1) input = { nested: input };
    const output = JSON.stringify(redactClassifiedPayload(input, 'PUBLIC'));
    expect(output).toContain('[DEPTH-LIMIT]');
    expect(output).not.toContain(SECRET);
  });
  it('exports only an allowlisted tombstone projection, ignoring extra raw data', async () => {
    const { port } = await governanceFixture();
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: SECRET, reasonRef: SECRET },
      SECRET,
      new Date(CREATED),
    );
    const events: Readonly<Record<string, unknown>>[] = [];
    expect(
      await exportGovernanceMarkers(port, (event) => {
        events.push(event);
        return Promise.resolve();
      }),
    ).toBe(1);
    const audit = (await port.snapshot()).audit[0];
    expect(events).toEqual([governanceSiemMarker(audit)]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0].redaction_marker).toBe('governance-tombstone-v1');
    expect(events[0].deletion_request).not.toBe(REQUEST_ID);
    expect(Object.isFrozen(events[0])).toBe(true);
  });
});
