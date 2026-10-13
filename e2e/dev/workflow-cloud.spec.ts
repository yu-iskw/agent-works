import { expect, test } from '@playwright/test';

// No credentials are accepted here. An operator starts an authenticated local
// driver that owns fault injection and cloud access, then opts in explicitly.
const enabled = process.env.WORKFLOW_CLOUD_OPERATOR_TESTS === '1';
const driverUrl = process.env.WORKFLOW_CLOUD_DRIVER_URL;

test.describe('operator Cloud Workflows acceptance', () => {
  test.skip(
    !enabled,
    'Operator-only cloud tests; set WORKFLOW_CLOUD_OPERATOR_TESTS=1 after reviewing the runbook',
  );

  for (const scenario of [
    'workflow.resume-after-kill',
    'workflow.duplicate-signal',
    'workflow.cancel-mid-write',
  ]) {
    test(scenario, async ({ request }, testInfo) => {
      test.setTimeout(180_000);
      expect(driverUrl, 'Start the operator driver and set WORKFLOW_CLOUD_DRIVER_URL').toBeTruthy();
      const driver = new URL(driverUrl ?? 'http://127.0.0.1');
      expect(driver.protocol).toBe('http:');
      expect(driver.hostname).toBe('127.0.0.1');
      expect(driver.username).toBe('');
      expect(driver.password).toBe('');
      expect(driver.search).toBe('');
      expect(driver.hash).toBe('');
      const response = await request.post(new URL(`/scenarios/${scenario}`, driver).href, {
        data: { scenario, tenant: 'synthetic', requireLedgerReconciliation: true },
        timeout: 150_000,
      });
      expect(response.ok()).toBeTruthy();
      const report: unknown = await response.json();
      await testInfo.attach(`${scenario}.json`, {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      expect(report).toMatchObject({
        scenario,
        operatorAuthorized: true,
        taskStatus: scenario === 'workflow.cancel-mid-write' ? 'CANCELLED' : 'COMPLETED',
        externalWriteCount: 1,
        duplicateExternalWriteCount: 0,
        receiptCount: 1,
        outboxReceiptCount: 1,
        ledgerOutboxReconciled: true,
        authorizationRechecked: true,
        faultInjected: true,
        evidence: {
          taskId: expect.any(String),
          executionNames: expect.any(Array),
          externalReceiptId: expect.any(String),
          outboxEventIds: expect.any(Array),
        },
      });
    });
  }
});
