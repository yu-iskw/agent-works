import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { readVertexConfig } from '@agent-works/agent-runtime';
import { createSealer, loadKey } from '@agent-works/domain/sealer';

import { createAdmissionService } from '../admission/postgres-admission.js';
import { applyStandingGrantMigration } from '../authority-lifecycle/migration.js';
import { createPostgresGrantStore } from '../authority-lifecycle/postgres-store.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';
import { modelRemediation } from '../workbench/model-port.js';
import { createVertexModel } from '../workbench/vertex.js';

import { registerBotExecution } from './bots/execution/engine.js';
import { createBotGrantRoutes } from './bots/execution/grant-routes.js';
import { applyBotExecutionMigration } from './bots/execution/migration.js';
import { createBotRunRoutes } from './bots/execution/run-routes.js';
import { createStartBotRun } from './bots/execution/start.js';
import { applyBotsMigration } from './bots/migration.js';
import { createBotRoutes } from './bots/routes.js';
import { createBotService } from './bots/service.js';
import { seedCatalog } from './catalog.js';
import { connections } from './connections.js';
import { applyGraphMigration } from './graph-migration.js';
import {
  bootstrapInstallations,
  findInstallable,
  listInstallations,
  segmentCapabilities,
  updateInstallation,
} from './installations.js';
import { parseAgentRegistry } from './mcp-task/index.js';
import { createModelGate } from './model.js';
import { createReconciler } from './reconciler.js';
import { createRoutes } from './routes.js';
import { unavailableRuntimeManager } from './runtime-manager.js';
import { createScriptedModel } from './scripted-model.js';
import {
  applySkillPackagesMigration,
  createSkillPackageStore,
  syncCuratedPackages,
} from './skill-packages/index.js';
import { createFixtureSources } from './sources/fixture.js';
import { createLiveSources } from './sources/live.js';
import { createWorker } from './worker.js';

import type { StartBotRun } from './bots/execution/start.js';
import type { SegmentConfig, SegmentSources } from './config.js';
import type { Deps, Member, Reply, Request } from './context.js';
import type { ModelGate } from './model.js';
import type { RuntimeManager } from './runtime-manager.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { ModelErrorCode } from '../workbench/model-port.js';
import type postgres from 'postgres';

type Env = Readonly<Record<string, string | undefined>>;

export type TeamworkRuntime = {
  readonly deps: Deps;
  readonly startBotRun: StartBotRun;
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
    campaign: gate.campaign,
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
  /** Out-of-process connector runtime; only a fake exists, so the default refuses every call. */
  readonly runtimeManager?: RuntimeManager;
}): Promise<TeamworkRuntime> {
  const { sql, config, env } = input;
  await applyWorkbenchMigration(sql);
  await applyGraphMigration(sql);
  if (env.AW_BOT_WORKFLOWS === 'on') await applyBotsMigration(sql);
  const vertex = modelFor(env, config);
  const now = () => new Date();
  const gate = createModelGate({
    sql,
    segment: config.segment,
    model: vertex.model,
    limit: config.maxModelCalls,
    campaign: config.modelCampaign,
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
    strictProposals: env.AW_STRICT_PROPOSALS === 'on',
  };
  await seedCatalog(deps);
  await bootstrapInstallations(deps);
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
      capabilities: [...(await segmentCapabilities(deps))],
      readOnly: config.readOnlyMembers.has(member.email),
      inbox: Object.fromEntries(open.map((row) => [row.kind, row.n])),
      sources: sourcesReadiness(config.sources),
    };
  }

  const bot = env.AW_BOT_WORKFLOWS === 'on' ? await configureBots(deps, env) : undefined;
  const route = createRoutes(deps, input.verify, readiness, bot?.routes ?? []);
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
  const reconciler = createReconciler(
    { list: () => listInstallations(deps), update: (change) => updateInstallation(deps, change) },
    {
      segment: config.segment,
      runtime: input.runtimeManager ?? unavailableRuntimeManager,
      manifest: findInstallable,
      now,
      onError: (error) =>
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'teamwork-reconciler',
            segment: config.segment,
            error: error instanceof Error ? error.name : 'unknown',
          }),
        ),
    },
  );
  return {
    startBotRun:
      bot?.startBotRun ?? (() => Promise.resolve({ kind: 'denied', code: 'feature_disabled' })),
    route,
    start: () => {
      worker.start();
      reconciler.start();
    },
    stop: async () => {
      await reconciler.stop();
      await worker.stop();
    },
    deps,
  };
}

async function configureBots(deps: Deps, env: Env) {
  await applyStandingGrantMigration(deps.sql);
  await applySkillPackagesMigration(deps.sql);
  await applyBotExecutionMigration(deps.sql);
  const admission = await createAdmissionService({
    sql: deps.sql,
    leaseMs: 300_000,
    now: deps.now,
  });
  const skills = createSkillPackageStore(deps.sql);
  const curated = await syncCuratedPackages({ store: skills });
  const activate = new Set(
    (env.AW_BOT_ACTIVATE_CURATED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const item of curated) {
    if (item.report.manifest && activate.has(item.report.manifest.name))
      await skills.activate(
        item.report.manifest.name,
        item.report.manifest.version,
        'segment-config',
      );
  }
  const registryJson = await registryConfig(env);
  const allowLoopback =
    env.AW_BOT_MCP_ALLOW_LOOPBACK === 'on' &&
    env.NODE_ENV !== 'production' &&
    deps.config.identity === 'local-test';
  const registry = parseAgentRegistry(registryJson, { allowLoopback });
  const service = createBotService(deps, async () => ({
    segmentCapabilities: await segmentCapabilities(deps),
    approvedAgents: registry,
    skills,
  }));
  const options = {
    deps,
    service,
    registry,
    allowLoopback,
    skills,
    admission,
    grants: createPostgresGrantStore(deps.sql),
  };
  const execution = registerBotExecution(options);
  return {
    startBotRun: createStartBotRun(options),
    routes: [
      ...createBotRoutes(deps, service),
      ...createBotRunRoutes(options, execution),
      ...createBotGrantRoutes(options),
    ],
  };
}

async function registryConfig(env: Env): Promise<unknown> {
  let registryJson: unknown = [];
  if (env.AW_BOT_MCP_AGENTS) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-owned configuration path
      registryJson = JSON.parse(await readFile(env.AW_BOT_MCP_AGENTS, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        console.warn(
          JSON.stringify({
            component: 'bot-config',
            code: 'registry_missing',
            field: 'AW_BOT_MCP_AGENTS',
          }),
        );
      else throw new Error('Invalid bot configuration fields: AW_BOT_MCP_AGENTS');
    }
  } else
    console.warn(
      JSON.stringify({
        component: 'bot-config',
        code: 'registry_missing',
        field: 'AW_BOT_MCP_AGENTS',
      }),
    );
  return registryJson;
}
