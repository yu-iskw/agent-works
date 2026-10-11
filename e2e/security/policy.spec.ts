import { expect, test } from '@playwright/test';

test('sec.policy-fail-closed', async ({ page }) => {
  const { POLICY_CLAUSES } = await import('../../packages/domain/src/policy.ts');
  const { whenAllowed } = await import('../../packages/policy/src/index.ts');
  let ran = false;
  const decision = whenAllowed({ facts: {} }, () => {
    ran = true;
  });
  expect(decision.effect).toBe('deny');
  expect(decision.failedClauses).toEqual([...POLICY_CLAUSES]);
  expect(ran).toBe(false);
  await page.setContent('<main><p>DENY</p><p>tool-ran=false</p></main>');
  await expect(page.getByText('tool-ran=false')).toBeVisible();
});

test('sec.model-claims-approval', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const { explainFixture } = await import('../../packages/cli/src/explain.ts');
  const { whenAllowed } = await import('../../packages/policy/src/index.ts');
  const raw: unknown = JSON.parse(
    readFileSync('fixtures/policy/model-claims-approval.json', 'utf8'),
  );
  expect(explainFixture(raw)).toBe('DENY valid_approval_if_required\n');
  let ran = false;
  const decision = whenAllowed(
    {
      facts: {
        authenticated_actor: true,
        active_org_membership: true,
        permitted_app_role: true,
        approved_agent_and_skill_version: true,
        agent_has_tool_capability: true,
        user_or_service_has_resource_authority: true,
        source_system_allows_operation: true,
        data_classification_policy_allows: true,
        valid_approval_if_required: false,
        within_time_and_budget_bounds: true,
      },
    },
    () => {
      ran = true;
    },
  );
  expect(decision.failedClauses).toEqual(['valid_approval_if_required']);
  expect(ran).toBe(false);
  await page.setContent('<main><p>DENY</p></main>');
  await expect(page.getByText('DENY')).toBeVisible();
});
