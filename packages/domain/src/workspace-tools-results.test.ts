import { describe, expect, it } from 'vitest';

import { workspaceReceiptSchema, workspaceSourcesSchema } from './workspace-tools.js';
describe('workspace response contracts', () => {
  it.each(['document', 'event', 'draft'] as const)('validates %s receipt', (kind) => {
    expect(workspaceReceiptSchema.parse({ id: 'object-1', kind })).toEqual({
      id: 'object-1',
      kind,
    });
  });
  it('rejects empty receipts and send receipts', () => {
    expect(workspaceReceiptSchema.safeParse({ id: '', kind: 'draft' }).success).toBe(false);
    expect(workspaceReceiptSchema.safeParse({ id: 'sent-1', kind: 'sent' }).success).toBe(false);
  });
  it('rejects a leaked token in a receipt', () => {
    expect(
      workspaceReceiptSchema.safeParse({ id: 'doc-1', kind: 'document', token: 'secret' }).success,
    ).toBe(false);
  });
  it('requires source classification before runner delivery', () => {
    expect(workspaceSourcesSchema.safeParse([{ id: 'm1', title: 'T', body: 'B' }]).success).toBe(
      false,
    );
    expect(
      workspaceSourcesSchema.parse([
        { id: 'm1', title: 'T', body: 'B', classification: 'CONFIDENTIAL' },
      ]),
    ).toHaveLength(1);
  });
  it('rejects an invented classification', () => {
    expect(
      workspaceSourcesSchema.safeParse([
        { id: 'm1', title: 'T', body: 'B', classification: 'SAFE' },
      ]).success,
    ).toBe(false);
  });
  it('bounds source count', () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `m${i}`,
      title: 'T',
      body: 'B',
      classification: 'CONFIDENTIAL',
    }));
    expect(workspaceSourcesSchema.safeParse(rows).success).toBe(false);
  });
});
