import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDataset } from '../../tools/evals/dataset.mjs';
import { loadRuntime } from '../../tools/evals/runtime.mjs';
import { scoreDataset } from '../../tools/evals/scorer.mjs';
const instant = new Date('2026-10-14T00:00:00.000Z');
/** Report only: quality differences never set an exit failure or enable a production flag. */
export async function delegationReport({ write = true } = {}) {
  const dataset = loadDataset({ splits: ['dev', 'adversarial'], includeHoldout: false });
  const { runCase } = await loadRuntime();
  const { createDelegator } = await import('../../apps/api/src/delegation/orchestrator.js');
  const { createMemoryDelegationPort } =
    await import('../../apps/api/src/ports/memory/delegation.js');
  const { createMemoryBudgetPort } = await import('../../apps/api/src/finops/memory-budget.js');
  const { citationVerifier } = await import('../../apps/api/src/delegation/verifier.js');
  const { createAdversarialTransport } =
    await import('../../packages/fakes/src/adversarial/index.js');
  const { createHttpDrive } = await import('../../apps/api/src/retrieval/http-drive.js');
  const { createScriptedRunner } = await import('../../apps/api/src/agent/scripted-runner.js');
  const baseline = [];
  const delegated = [];
  const measurements = [];
  for (const row of dataset.cases) {
    const before = performance.now();
    const single = await runCase(row);
    baseline.push(single);
    const baselineMs = performance.now() - before;
    // Fault, hostile and write scenarios stay on the single orchestrator's deterministic path.
    if (row.scenario !== 'retrieval' || row.fault !== 'none') {
      delegated.push(structuredClone(single));
      measurements.push({
        caseId: row.id,
        applicable: false,
        children: 0,
        baselineMs,
        delegatedMs: 0,
        estimatedCostMicros: 0,
      });
      continue;
    }
    const start = performance.now();
    const transport = createAdversarialTransport({
      documents: row.documents,
      subject: row.principal.subject,
      groups: row.principal.groups,
    });
    const drive = createHttpDrive({
      baseUrl: 'https://drive.fake.test',
      directoryUrl: 'https://directory.fake.test',
      fetch: transport.fetch,
      now: () => instant,
    });
    const sources = await drive.retrieve(
      { sub: row.principal.subject, assertion: 'offline-verified-subject-fixture' },
      row.question,
    );
    const limits = {
      approval: 'PLACEHOLDER',
      estimatedCostMicros: 100000,
      inferenceSteps: 1000,
      parallelism: 100,
    };
    const records = createMemoryDelegationPort();
    const budget = createMemoryBudgetPort();
    const parent = {
      taskId: row.id,
      rootTaskId: row.id,
      parentTaskId: null,
      traceId: `trace:${row.id}`,
      depth: 0,
      authority: {
        subject: row.principal.subject,
        agentPrincipal: 'offline:orchestrator',
        region: 'asia-northeast1',
        governanceZone: 'fixture',
        grants: sources.map((source) => ({ capability: 'drive.read', resource: source.id })),
        expiresAt: '2027-01-01T00:00:00.000Z',
        policyDecisionRef: 'offline-policy',
      },
      budgetShare: limits,
      budgetScope: {
        taskId: row.id,
        userSubject: row.principal.subject,
        sponsor: 'offline',
        window: 'fixture',
      },
    };
    const verifier = citationVerifier(
      new Map(sources.map((source) => [source.id, source.text])),
      'independent-extractive-verifier-v1',
    );
    const orchestrator = createDelegator({
      flag: 'enabled',
      maxDepth: 1,
      records,
      budget,
      budgetPolicy: { task: limits, user: limits, mode: 'observe' },
      verifier,
      now: () => instant,
      execute: async (context) => {
        const authorized = new Set(context.authority.grants.map((grant) => grant.resource));
        const visible = sources.filter((source) => authorized.has(source.id));
        const model = createAdversarialTransport({
          documents: [],
          subject: row.principal.subject,
          groups: [],
          modelAnswer: visible.map((source) => `${source.text} [${source.id}]`).join('\n'),
        });
        return createScriptedRunner({ baseUrl: 'https://llm.fake.test', fetch: model.fetch }).run({
          question: row.question,
          sources: visible,
        });
      },
    });
    const results = [];
    let rejected = 0;
    for (const [index, source] of sources.entries()) {
      try {
        results.push(
          await orchestrator.spawn(parent, {
            childTaskId: `${row.id}:child:${index}`,
            grants: [{ capability: 'drive.read', resource: source.id }],
            budgetShare: { ...limits, estimatedCostMicros: 1, inferenceSteps: 1, parallelism: 1 },
          }),
        );
      } catch {
        rejected++;
      }
    }
    const outcome = {
      schemaVersion: '1.0.0',
      caseId: row.id,
      status: results.length ? 'answered' : 'abstained',
      answer: results.map((result) => result.answer).join('\n'),
      citations: results.flatMap((result) => result.citedSourceIds),
      retrievedSourceIds: sources.map((source) => source.id),
      calls: [
        {
          tool: 'drive.search',
          arguments: { query: row.question },
          authorized: true,
          outcome: 'executed',
        },
      ],
      diagnostics: rejected ? ['independent verification rejected child results'] : [],
      workflow: results.length ? 'complete' : 'blocked',
    };
    delegated.push(outcome);
    measurements.push({
      caseId: row.id,
      applicable: true,
      children: sources.length,
      verified: results.length,
      rejected,
      baselineMs,
      delegatedMs: performance.now() - start,
      estimatedCostMicros: (await budget.events()).reduce(
        (sum, event) => sum + event.estimatedCostMicros,
        0,
      ),
    });
  }
  const singleReport = scoreDataset(dataset.cases, baseline);
  const delegatedReport = scoreDataset(dataset.cases, delegated);
  const report = {
    schemaVersion: '1.0.0',
    mode: 'report-only',
    gating: false,
    evidence: 'offline-fakes-only',
    realServicesGatePassed: false,
    dataset: { version: '1.0.0', splits: dataset.splits, fingerprints: dataset.fingerprints },
    singleOrchestrator: singleReport,
    delegatedDecomposition: delegatedReport,
    measurements,
    limitations: [
      'Synthetic keys remain unreviewed',
      'Elapsed time is local fixture wall time, not provider latency',
      'Cost micros are fixture allocations, not real prices',
      'Only successful retrieval cases are decomposed; other scenarios retain deterministic baseline',
      'Report does not activate routing rules or delegation',
    ],
  };
  if (write) {
    const directory = new URL('./reports/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('comparison.json', directory), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await delegationReport();
    console.log(
      JSON.stringify({
        mode: report.mode,
        cases: report.measurements.length,
        children: report.measurements.reduce((sum, row) => sum + row.children, 0),
      }),
    );
  } catch {
    console.log(JSON.stringify({ mode: 'report-only', gating: false, status: 'unavailable' }));
  }
}
