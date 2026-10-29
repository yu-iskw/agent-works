import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { createSealer, loadKey } from '@agent-works/domain/sealer';

import { applyWorkbenchMigration } from '../workbench/migration.js';
import { modelRemediation } from '../workbench/model-port.js';
import { createVertexModel, readVertexConfig } from '../workbench/vertex.js';

import { seedCatalog } from './catalog.js';
import { connections } from './connections.js';
import { createModelGate } from './model.js';
import { createRoutes } from './routes.js';
import { createScriptedModel } from './scripted-model.js';
import { createFixtureSources } from './sources/fixture.js';
import { createLiveSources } from './sources/live.js';
import { createWorker } from './worker.js';

import type { SegmentConfig, SegmentSources } from './config.js';
import type { Deps, Member, Reply, Request } from './context.js';
import type { ModelGate } from './model.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { ModelErrorCode } from '../workbench/model-port.js';
import type postgres from 'postgres';

type Env = Readonly<Record<string, string | undefined>>;

export type TeamworkRuntime = {
  readonly deps: Deps;
  route(request: Request): Promise<Reply>;
  start(): void;
  stop(): Promise<void>;
};

/**
 * Live calls are the only model mode a segment API has. `LLM_MODE=disabled` (CI) refuses every
 * generation with `not_configured`. The only other mode is the labelled scripted model for UI
 * review, which refuses to run with a real identity or live sources; nothing falls back to it.
 */
function modelFor(env: Env, config: SegmentConfig) {
  if (env.LLM_MODE === 'scripted') {
    // UI review rounds only: never with a real identity or live sources.
    if (config.identity !== 'local-test' || config.sourceMode !== 'fixture')
      return {
        model: undefined,
        missing: ['LLM_MODE=scripted requires AW_IDENTITY=local-test and AW_SOURCE_MODE=fixture'],
      };
    return { model: createScriptedModel(), missing: [] as readonly string[] };
  }
  if (env.LLM_MODE !== 'vertex') return { model: undefined, missing: ['LLM_MODE=vertex'] };
  const vertex = readVertexConfig(env);
  if ('missing' in vertex) return { model: undefined, missing: vertex.missing };
  return { model: createVertexModel(vertex), missing: [] as readonly string[] };
}

type LastCall = {
  outcome: string;
  at: Date;
  latency_ms: number | null;
  model_version: string | null;
};
type Adc = 'ambient' | 'present' | 'missing';

function credentialsState(credentialsPath: string | undefined): Adc {
  if (credentialsPath === undefined) return 'ambient';
  // Operator-supplied credentials path from the environment, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return existsSync(credentialsPath) ? 'present' : 'missing';
}

function modelErrorCode(
  gate: ModelGate,
  used: number,
  lastCall: LastCall | undefined,
  adc: Adc,
): string | null {
  if (!gate.configured) return 'not_configured';
  if (adc === 'missing') return 'adc_unavailable';
  if (lastCall !== undefined && lastCall.outcome !== 'ok') return lastCall.outcome;
  return used >= gate.limit ? 'budget_exhausted' : null;
}

function modelReadiness(
  gate: ModelGate,
  input: { used: number; lastCall: LastCall | undefined; adc: Adc; concurrency: number },
) {
  const { used, lastCall, adc, concurrency } = input;
  const errorCode = modelErrorCode(gate, used, lastCall, adc);
  return {
    modelId: gate.modelId,
    mode: gate.mode,
    state: errorCode !== null ? 'error' : lastCall === undefined ? 'unverified' : 'ready',
    credentials: adc,
    callsUsed: used,
    callsLimit: gate.limit,
    concurrency,
    lastCall:
      lastCall === undefined
        ? null
        : {
            at: lastCall.at.toISOString(),
            outcome: lastCall.outcome,
            latencyMs: lastCall.latency_ms,
            modelVersion: lastCall.model_version,
          },
    errorCode,
    remediation:
      errorCode !== null && errorCode in modelRemediation
        ? modelRemediation[errorCode as ModelErrorCode]
        : null,
  };
}

function sourcesReadiness(sources: SegmentSources) {
  return {
    repositories: sources.githubRepositories,
    issue: sources.githubIssue ?? null,
    pinnedRef: sources.githubPinnedRef ?? null,
    dataset: sources.bigqueryDataset ?? null,
    driveConfigured:
      sources.driveResearchFolder !== undefined && sources.driveContextFolder !== undefined,
  };
}

export async function createTeamworkRuntime(input: {
  readonly sql: postgres.Sql;
  readonly config: SegmentConfig;
  readonly env: Env;
  readonly verify: VerifyAssertion;
  readonly fetch?: typeof fetch;
}): Promise<TeamworkRuntime> {
  const { sql, config, env } = input;
  await applyWorkbenchMigration(sql);
  const vertex = modelFor(env, config);
  const now = () => new Date();
  const gate = createModelGate({
    sql,
    segment: config.segment,
    model: vertex.model,
    limit: config.maxModelCalls,
    now,
  });
  const sources =
    config.sourceMode === 'fixture'
      ? createFixtureSources({
          root: process.cwd(),
          segment: config.segment,
          sql,
          faults: env.AW_FIXTURE_FAULTS === '1',
        })
      : createLiveSources(config.sources, input.fetch ?? fetch);
  const deps: Deps = {
    sql,
    config,
    gate,
    sources,
    sealer: createSealer(loadKey(config.keyDir, 'token.key'), `aw-m1:${config.segment}:tokens`),
    now,
    newId: randomUUID,
    fetch: input.fetch ?? fetch,
  };
  await seedCatalog(deps);
  const adc = credentialsState(env.GOOGLE_APPLICATION_CREDENTIALS);

  async function readiness(member: Member) {
    const [used, last, open, connected] = await Promise.all([
      gate.used(),
      sql<LastCall[]>`
        select outcome, at, latency_ms, model_version from wb_model_calls where segment = ${config.segment} and outcome <> 'pending'
        order by id desc limit 1
      `,
      sql<
        { kind: string; n: number }[]
      >`select kind, count(*)::int as n from tw_inbox where owner_sub = ${member.sub} and state = 'open' group by kind`,
      connections(deps, member),
    ]);
    return {
      segment: { id: config.segment, name: config.segmentName },
      member: { sub: member.sub, email: member.email },
      identity: config.identity,
      sourceMode: config.sourceMode,
      missingConfig: [...config.missing, ...vertex.missing],
      model: modelReadiness(gate, {
        used,
        lastCall: last.at(0),
        adc,
        concurrency: config.concurrency,
      }),
      connections: connected,
      capabilities: [...config.capabilities],
      readOnly: config.readOnlyMembers.has(member.email),
      inbox: Object.fromEntries(open.map((row) => [row.kind, row.n])),
      sources: sourcesReadiness(config.sources),
    };
  }

  const route = createRoutes(deps, input.verify, readiness);
  const worker = createWorker(deps, (error) =>
    console.error(
      JSON.stringify({
        level: 'error',
        component: 'teamwork-worker',
        segment: config.segment,
        error: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message.slice(0, 200) : '',
      }),
    ),
  );
  return { route, start: () => worker.start(), stop: () => worker.stop(), deps };
}
