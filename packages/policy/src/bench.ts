import { pathToFileURL } from 'node:url';

import { decide } from './decide.js';

import type { PolicyFacts } from './decide.js';

export function meanDecideMicroseconds(facts: PolicyFacts, iterations: number): number {
  const input = { facts };
  for (let warmup = 0; warmup < 200; warmup += 1) decide(input);
  let allows = 0;
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const decision = decide(input);
    if (decision.effect === 'allow') allows += 1;
  }
  const mean = ((performance.now() - started) / iterations) * 1000;
  if (allows !== iterations) throw new Error('bench skipped decisions');
  return mean;
}

function isDirectRun(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const mean = meanDecideMicroseconds(
    {
      authenticated_actor: true,
      active_org_membership: true,
      permitted_app_role: true,
      approved_agent_and_skill_version: true,
      agent_has_tool_capability: true,
      user_or_service_has_resource_authority: true,
      source_system_allows_operation: true,
      data_classification_policy_allows: true,
      valid_approval_if_required: true,
      within_time_and_budget_bounds: true,
    },
    2000,
  );
  process.stdout.write(`decide mean ${mean.toFixed(3)} us\n`);
  if (mean > 100) process.exitCode = 1;
}
