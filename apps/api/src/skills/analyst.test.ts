import { describe, expect, it, vi } from 'vitest';

import {
  analyticsFixture,
  analyticsPrincipal,
  analyticsReportId,
  revenueQuery,
} from '../analytics/fixtures.js';

import { createAnalystSkill } from './analyst.js';
import { createSkillRegistry } from './registry.js';

import type { AuthorizedCaller } from './incident.js';
import type { TaskAccepted, TaskSubmit } from '@agent-works/domain';
const request: TaskSubmit = {
  objective: 'Rerun reviewed report',
  skillId: 'analyst',
  sourceAllowlist: ['approved.sales'],
  requestedOutputs: ['analytics'],
  executionPolicy: { mode: 'read-only', budgetUsd: 0, deadlineSeconds: 60 },
};
const accepted: TaskAccepted = {
  taskId: 'analytics-task-147',
  status: 'QUEUED',
  submittedAt: new Date().toISOString(),
  statusUrl: '/v1/tasks/analytics-task-147',
  traceId: 'analytics-trace',
};
const authorized = {
  caller: { sub: 'alice', assertion: 'verified' },
  context: { allowedSources: ['approved.sales'] },
} as AuthorizedCaller;
describe('analyst skill dispatch', () => {
  it('registers the analyst manifest for schedule tasks', () =>
    expect(createSkillRegistry().get('analyst')?.manifest.tools).toEqual([
      'analytics.report.rerun@1',
    ]));
  it('accepts only a bounded version reference', () => {
    const skill = createAnalystSkill();
    expect(
      skill.validate({ ...request, input: { versionId: analyticsReportId, maxBytes: 1000 } }),
    ).toBe(true);
    expect(skill.validate({ ...request, input: { sql: 'SELECT 1' } })).toBe(false);
  });
  it('fails closed without explicit trusted configuration', async () => {
    await expect(createAnalystSkill().dispatch(request, accepted, authorized)).rejects.toThrow(
      'ANALYST_UNAVAILABLE',
    );
  });
  it('deduplicates concurrent dispatch for one task', async () => {
    const { service, port } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, {
      reportId: analyticsReportId,
      title: 'Revenue',
      humanValidated: true,
      query: revenueQuery(),
    });
    const skill = createAnalystSkill(() => ({
      service,
      authority: () => Promise.resolve(analyticsPrincipal),
    }));
    const input = { ...request, input: { versionId: report.id, maxBytes: 100000 } };
    await Promise.all([
      skill.dispatch(input, accepted, authorized),
      skill.dispatch(input, accepted, authorized),
    ]);
    await skill.dispatch(input, accepted, authorized);
    expect(skill.result(accepted.taskId)?.sql).toBe(report.sql);
    expect(await port.audits()).toHaveLength(2);
  });
  it('uses freshly resolved dataset authority', async () => {
    const { service } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, {
      reportId: analyticsReportId,
      title: 'Revenue',
      humanValidated: true,
      query: revenueQuery(),
    });
    const skill = createAnalystSkill(() => ({
      service,
      authority: () => Promise.resolve({ ...analyticsPrincipal, datasets: [] }),
    }));
    await expect(
      skill.dispatch(
        { ...request, input: { versionId: report.id, maxBytes: 100000 } },
        accepted,
        authorized,
      ),
    ).rejects.toThrow('DATASET_FORBIDDEN');
    expect(skill.result(accepted.taskId)).toBeUndefined();
  });
  it('intersects fresh grants with the task source ceiling', async () => {
    const { service, engine } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, {
      reportId: analyticsReportId,
      title: 'Revenue',
      humanValidated: true,
      query: revenueQuery(),
    });
    const execute = vi.spyOn(engine, 'execute');
    const skill = createAnalystSkill(() => ({
      service,
      authority: () => Promise.resolve(analyticsPrincipal),
    }));
    await expect(
      skill.dispatch({ ...request, input: { versionId: report.id, maxBytes: 100000 } }, accepted, {
        ...authorized,
        context: { ...authorized.context, allowedSources: ['approved.customers'] },
      }),
    ).rejects.toThrow('DATASET_FORBIDDEN');
    expect(execute).not.toHaveBeenCalled();
    expect(skill.result(accepted.taskId)).toBeUndefined();
  });
  it.each(['cancel', 'deadline'] as const)(
    'stops before execution after %s during dry-run',
    async (stop) => {
      const { service, engine, budget } = await analyticsFixture();
      const report = await service.save(analyticsPrincipal, {
        reportId: analyticsReportId,
        title: 'Revenue',
        humanValidated: true,
        query: revenueQuery(),
      });
      const controller = new AbortController();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now');
      vi.spyOn(engine, 'dryRun').mockImplementation((query) => {
        expect(query.execution?.deadline).toBeLessThanOrEqual(Date.now() + 60000);
        if (stop === 'cancel') controller.abort();
        else clock.mockReturnValue(now + 60001);
        return Promise.resolve({ bytes: 512 });
      });
      const execute = vi.spyOn(engine, 'execute');
      const skill = createAnalystSkill(() => ({
        service,
        authority: () => Promise.resolve(analyticsPrincipal),
      }));
      try {
        await expect(
          skill.dispatch(
            { ...request, input: { versionId: report.id, maxBytes: 100000 } },
            accepted,
            authorized,
            { signal: controller.signal, deadline: now + 60000 },
          ),
        ).rejects.toThrow(stop === 'cancel' ? 'ANALYST_CANCELLED' : 'ANALYST_TIMEOUT');
      } finally {
        clock.mockRestore();
      }
      expect(execute).not.toHaveBeenCalled();
      expect(skill.result(accepted.taskId)).toBeUndefined();
      expect(
        (await budget.port.events()).filter((e) => e.scope.taskId === accepted.taskId),
      ).toEqual([]);
    },
  );
  it('propagates cancellation during execution and releases the task reservation', async () => {
    const { service, engine, budget, port } = await analyticsFixture();
    const report = await service.save(analyticsPrincipal, {
      reportId: analyticsReportId,
      title: 'Revenue',
      humanValidated: true,
      query: revenueQuery(),
    });
    const controller = new AbortController();
    const abortController = (): void => {
      controller.abort();
    };
    vi.spyOn(engine, 'execute').mockImplementation(async (query) => {
      const signal = query.execution?.signal;
      if (signal === undefined) throw new Error('execution signal missing');
      expect(signal.aborted).toBe(false);
      const aborted = abortedPromise(signal);
      queueMicrotask(abortController);
      await aborted;
      return [];
    });
    const skill = createAnalystSkill(() => ({
      service,
      authority: () => Promise.resolve(analyticsPrincipal),
    }));
    await expect(
      skill.dispatch(
        { ...request, input: { versionId: report.id, maxBytes: 100000 } },
        accepted,
        authorized,
        { signal: controller.signal, deadline: Date.now() + 60000 },
      ),
    ).rejects.toThrow('ANALYST_CANCELLED');
    expect(skill.result(accepted.taskId)).toBeUndefined();
    expect(
      (await budget.port.events())
        .filter((event) => event.scope.taskId === accepted.taskId)
        .map((event) => event.kind),
    ).toEqual(['charged', 'released']);
    expect((await port.audits()).at(-1)).toMatchObject({ reason: 'ANALYST_CANCELLED', rows: [] });
  });
  it.each([
    [{ deadline: Date.now() - 1 }, 'ANALYST_TIMEOUT'],
    [{ signal: AbortSignal.abort(), deadline: Date.now() + 60000 }, 'ANALYST_CANCELLED'],
  ])('rejects stopped execution before resolving authority: %s', async (execution, reason) => {
    const { service } = await analyticsFixture();
    const authority = vi.fn(() => Promise.resolve(analyticsPrincipal));
    const skill = createAnalystSkill(() => ({ service, authority }));
    await expect(skill.dispatch(request, accepted, authorized, execution)).rejects.toThrow(reason);
    expect(authority).not.toHaveBeenCalled();
  });
});

function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
