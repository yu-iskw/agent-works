import { describe, expect, it } from 'vitest';

import {
  analyticsFixture,
  analyticsPrincipal,
  analyticsReportId,
  revenueQuery,
} from './fixtures.js';
import { executeAnalyticsReportTask } from './schedule-task.js';
describe('existing schedule task hook', () => {
  it('reruns an immutable version under the schedule task budget scope', async () => {
    const { service, budget } = await analyticsFixture();
    const version = await service.save(analyticsPrincipal, {
      reportId: analyticsReportId,
      title: 'Scheduled revenue',
      humanValidated: true,
      query: revenueQuery(),
    });
    const result = await executeAnalyticsReportTask(
      service,
      analyticsPrincipal,
      { versionId: version.id, maxBytes: 100000 },
      'schedule-task-147',
    );
    expect(result.sql).toBe(version.sql);
    expect(
      (await budget.port.events()).find((e) => e.scope.taskId === 'schedule-task-147')?.scope
        .sponsor,
    ).toBe('alice');
  });
  it('requires a version reference and rejects free SQL in schedules', async () => {
    const { service } = await analyticsFixture();
    await expect(
      executeAnalyticsReportTask(service, analyticsPrincipal, { sql: 'SELECT 1' }, 'task-147'),
    ).rejects.toThrow();
  });
});
