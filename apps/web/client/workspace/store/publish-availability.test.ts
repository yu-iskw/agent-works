import { describe, expect, it } from 'vitest';

import { publishAvailability } from './publish-availability.js';

import type { TaskDetailPage } from '../../../shared/contract.js';
import type { ActionApprovalView, CapabilityState } from '@agent-works/domain/teamwork';

const detail = (over: Partial<TaskDetailPage['task']> = {}, approvals: ActionApprovalView[] = []) =>
  ({
    segment: 'alpha',
    task: {
      id: 'task-1',
      title: 'T',
      workflow: 'research_brief',
      mode: 'manual',
      status: 'ready',
      version: 4,
      resultOwner: 'tm-1',
      conversationId: null,
      latestRevision: 2,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z',
      ...over,
    },
    scope: { question: 'q', metrics: null, repository: null, issueNumber: null },
    plans: [],
    assignments: [],
    evidence: [],
    revisions: [],
    approvals,
    messages: [],
    events: [],
  }) as TaskDetailPage;

const approval = (revision: number, state: ActionApprovalView['state']): ActionApprovalView => ({
  id: '11111111-1111-4111-8111-111111111111',
  state,
  proposal: {
    tool: 'google_docs.create',
    account: 'alice@local.test (fixture Docs)',
    destination: 'A new Google Doc',
    documentTitle: 'T',
    revision,
    contentMarkdown: '# T',
    wordCount: 2,
    consequences: [],
  },
  digest: 'a'.repeat(64),
  requestedAt: '2026-10-30T00:00:00.000Z',
  expiresAt: '2026-10-30T01:00:00.000Z',
  decidedAt: null,
  action: null,
});

const docs = (effective: boolean, reason: string | null = null): CapabilityState => ({
  capability: 'docs.publish',
  requested: true,
  permitted: effective,
  connected: true,
  effective,
  reason,
});

const base = { detail: detail(), revision: 2, readOnly: false, ownerCapabilities: [docs(true)] };

describe('publishAvailability', () => {
  it('offers the latest revision of a ready task whose owner may publish', () => {
    expect(publishAvailability(base)).toEqual({ ok: true });
    expect(publishAvailability({ ...base, detail: detail({ status: 'completed' }) })).toEqual({
      ok: true,
    });
  });

  it('refuses an older revision and names the latest', () => {
    const result = publishAvailability({ ...base, revision: 1 });
    expect(result).toMatchObject({ ok: false, pending: false });
    expect(result.ok ? '' : result.reason).toContain('latest revision (2)');
  });

  it('hides nothing from a read-only member but explains why', () => {
    const result = publishAvailability({ ...base, readOnly: true });
    expect(result).toEqual({
      ok: false,
      pending: false,
      reason: 'Your membership is read-only, so nothing can be published.',
    });
  });

  it('refuses while an approval is pending, even for an older revision', () => {
    const same = publishAvailability({
      ...base,
      detail: detail({ status: 'awaiting_action_approval' }, [approval(2, 'pending')]),
    });
    expect(same.ok ? '' : same.reason).toContain('already waiting');
    const older = publishAvailability({
      ...base,
      detail: detail({ status: 'awaiting_action_approval' }, [approval(1, 'pending')]),
    });
    expect(older.ok ? '' : older.reason).toContain('revision 1 is still pending');
    expect(publishAvailability({ ...base, detail: detail({}, [approval(2, 'rejected')]) })).toEqual(
      { ok: true },
    );
  });

  it('refuses a revision that already produced a document', () => {
    const done = {
      ...approval(2, 'approved'),
      action: {
        status: 'succeeded' as const,
        attempts: 1,
        externalId: 'fxdoc-1',
        externalUrl: '/fixtures/docs/fxdoc-1',
        confirmedAt: '2026-10-30T00:10:00.000Z',
      },
    };
    const result = publishAvailability({
      ...base,
      detail: detail({ status: 'completed' }, [done]),
    });
    expect(result).toEqual({
      ok: false,
      pending: false,
      reason: 'Revision 2 is already published; a second copy is never created.',
    });
  });

  it('refuses a task that is not ready or completed', () => {
    for (const status of ['running', 'synthesizing', 'failed', 'cancelled'] as const) {
      const result = publishAvailability({ ...base, detail: detail({ status }) });
      expect(result.ok ? status : `${status}: ${result.reason}`).toContain('ready or completed');
    }
  });

  it('reports a pending check while the owner capabilities load', () => {
    expect(publishAvailability({ ...base, ownerCapabilities: undefined })).toEqual({
      ok: false,
      pending: true,
      reason: 'Checking what the result owner may do…',
    });
  });

  it('uses the segment reason when docs.publish is not effective', () => {
    expect(
      publishAvailability({ ...base, ownerCapabilities: [docs(false, 'Google is not connected')] }),
    ).toEqual({ ok: false, pending: false, reason: 'Google is not connected' });
    const none = publishAvailability({ ...base, ownerCapabilities: [] });
    expect(none.ok ? '' : none.reason).toContain('no effective docs.publish');
  });
});
