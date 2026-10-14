/* eslint-disable security/detect-non-literal-fs-filename -- reads fixed checked-in analytics acceptance fixtures only */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyticsSiem } from './siem.js';

import type { AnalyticsAudit } from '../ports/analytics.js';
const event: AnalyticsAudit = {
  id: '14700000-0000-4000-8000-000000000002',
  at: '2026-10-14T10:00:00.000Z',
  subjectHash: 'a'.repeat(64),
  queryHash: 'b'.repeat(64),
  paramsHash: 'c'.repeat(64),
  outcome: 'allowed',
  reason: null,
  vetted: false,
  estimatedBytes: 512,
  columns: { region: 'INTERNAL', email: 'RESTRICTED' },
  rows: [{ region: 'east', email: 'secret@example.invalid' }],
};
describe('analytics SIEM golden snapshot', () => {
  it('exports masked result columns with digests only', () => {
    const golden: unknown = JSON.parse(
      readFileSync(
        new URL('../../../../evals/fixtures/analytics-siem-golden.json', import.meta.url),
        'utf8',
      ),
    );
    expect(analyticsSiem(event)).toEqual(golden);
    expect(JSON.stringify(analyticsSiem(event))).not.toContain('secret@example.invalid');
  });
  it('does not mutate source evidence', () => {
    analyticsSiem(event);
    expect(event.rows[0].email).toBe('secret@example.invalid');
  });
});
