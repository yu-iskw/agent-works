import { randomUUID } from 'node:crypto';

import { applyWorkbenchMigration } from './migration.js';
import { createWorkbenchRoute } from './routes.js';
import { createWorkbenchService } from './service.js';
import { createStubModel } from './stub-model.js';
import { createVertexModel, readVertexConfig } from './vertex.js';
import { createWorkbenchWorker } from './worker.js';
import { createFixtureWorkspace } from './workspace.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { ModelSetup } from './service.js';
import type postgres from 'postgres';

type Env = Readonly<Record<string, string | undefined>>;

/** LLM_MODE=stub is the only way to get the offline model; anything else means Vertex. */
function modelSetup(env: Env, faultsEnabled: boolean): ModelSetup {
  if (env.LLM_MODE === 'stub') return { kind: 'ready', model: createStubModel(faultsEnabled) };
  const config = readVertexConfig(env);
  if ('missing' in config) return { kind: 'not_configured', missing: config.missing };
  return { kind: 'ready', model: createVertexModel(config) };
}

/** Unset means the default; anything that is not a whole number fails closed to zero calls. */
export function callLimit(value: string | undefined): number {
  if (value === undefined) return 150;
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
}

export async function createWorkbenchRuntime(
  sql: postgres.Sql,
  verify: VerifyAssertion,
  env: Env,
): Promise<{ readonly route: Route; start(): void; stop(): Promise<void> }> {
  await applyWorkbenchMigration(sql);
  const workspace = createFixtureWorkspace(sql);
  const faultsEnabled = env.WORKSPACE_FIXTURE_FAULTS === '1';
  const deps = {
    sql,
    model: modelSetup(env, faultsEnabled),
    workspace,
    faultsEnabled,
    maxModelCalls: callLimit(env.WORKBENCH_MAX_MODEL_CALLS),
    vertex: {
      project: env.GOOGLE_CLOUD_PROJECT ?? '',
      location: env.GOOGLE_CLOUD_LOCATION ?? '',
    },
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
    now: () => new Date(),
    newId: randomUUID,
  };
  const service = createWorkbenchService(deps);
  const worker = createWorkbenchWorker({
    deps,
    onError: (error) =>
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'workbench-worker',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      ),
  });
  return {
    route: createWorkbenchRoute({ verify, service, workspace }),
    start: worker.start,
    stop: worker.stop,
  };
}
