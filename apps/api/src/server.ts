import { createServer } from 'node:http';

import { workspaceManifests } from '@agent-works/domain/workspace-tools';

import { createAdmissionService } from './admission/postgres-admission.js';
import { createScriptedRunner } from './agent/scripted-runner.js';
import { createApp } from './app.js';
import { createPostgresAuditLog } from './audit/write.js';
import { createPostgresApprovalStore } from './broker/approvals.js';
import { admittedSkill } from './composition/admission.js';
import { buildBackgroundLoops } from './composition/background.js';
import { createDeliveryRoutes } from './composition/delivery.js';
import { readWiring } from './composition/flags.js';
import { buildOpsDashboard, buildQueuePublisher, buildTelemetry } from './composition/parts.js';
import { prepareRoutines } from './composition/routines.js';
import { loadConfig } from './config.js';
import { createDevWorkspaceRuntime } from './connectors/dev-runtime.js';
import { createOAuthFlow } from './credentials/flow.js';
import { createPostgresCredentialStore } from './credentials/postgres.js';
import { openDatabase } from './db.js';
import { createPostgresDispatchPort } from './ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from './ledger/postgres-ledger.js';
import { ContextMismatch } from './retrieval/search.js';
import { createPostgresOAuthConnectionsReader } from './routes/oauth-connections-read.js';
import { createScheduleRuntime } from './scheduling/runtime.js';
import { createIncidentSkill } from './skills/incident.js';
import { createMeetingPrepSkill } from './skills/meeting-prep.js';
import { createSkillRegistry } from './skills/registry.js';
import { createTaskDispatcher } from './skills/task-dispatcher.js';
import { taskSkillPolicy } from './skills/task-policy.js';
import { createTicketReconciler } from './skills/ticket-receipts.js';
import { buildProviderPorts } from './startup/ports.js';
import { assertStartup } from './startup/providers.js';
import { publishBundledCapabilities } from './suspension/bootstrap.js';
import { createSuspensionEnforcer } from './suspension/enforcement.js';
import { listOutstandingOperations } from './suspension/outstanding.js';
import { createPostgresSuspensionLedger } from './suspension/postgres.js';
import {
  authorizeResource,
  beforeReadTool,
  bundledVersionBaseline,
  controlledListener,
  controlledRunner,
  controlledSkill,
  controlledVerify,
  emergencyAudit,
} from './suspension/runtime.js';
import { createWorkbenchRuntime } from './workbench/runtime.js';

import type { Caller } from './auth/iap.js';
import type { RegisteredSkill } from './skills/incident.js';
import type { SearchContext } from '@agent-works/domain';

assertStartup(process.env);
const wiring = readWiring(process.env);
const telemetry = buildTelemetry(wiring);
const config = loadConfig(process.env);
const sql = await openDatabase(config.databaseUrl);
const now = () => new Date();
const ports = buildProviderPorts(config, process.env, now);
const { drive, groups, rolesFor, oauthUrl } = ports;
const ledger = createPostgresLedgerPort(sql, now);
const suspensionLedger = createPostgresSuspensionLedger(sql);
const oauth =
  oauthUrl === undefined || ports.oauthProvider === undefined
    ? undefined
    : createOAuthFlow({
        ...createPostgresCredentialStore(sql),
        provider: ports.oauthProvider,
        ledger,
        now,
      });
const callers = new WeakMap<SearchContext, Caller>();
const incidentSkill = createIncidentSkill(() => {
  if (config.incident === undefined) return undefined;
  const runner = controlledRunner(
    createScriptedRunner({ baseUrl: config.llmUrl, model: config.incident.model }),
    enforcement,
  );
  return {
    ...config.incident,
    model: { answer: async (question) => (await runner.run({ question, sources: [] })).answer },
  };
});
const baseline = bundledVersionBaseline(incidentSkill.manifest);
await publishBundledCapabilities(suspensionLedger, baseline);
const enforcement = createSuspensionEnforcer({
  ledger: suspensionLedger,
  emergencyAudit: emergencyAudit(ledger),
  telemetry,
});
const admission =
  wiring.admission === undefined
    ? undefined
    : await createAdmissionService({
        sql,
        leaseMs: wiring.admission.leaseMs,
        now,
        suspension: enforcement,
      });
const withAdmission = (skill: RegisteredSkill, model: string): RegisteredSkill =>
  admission === undefined || wiring.admission === undefined
    ? skill
    : admittedSkill(
        skill,
        admission,
        {
          segmentId: wiring.admission.segmentId,
          estimatedCostMicros: wiring.admission.estimatedCostMicros,
          leaseMs: wiring.admission.leaseMs,
          now,
          teamsFor: groups,
        },
        model,
      );
const verify = controlledVerify(ports.iap, groups, enforcement);
const workspace = (() => {
  if (process.env.AW_DEV_STACK === '1' && oauth !== undefined && oauthUrl !== undefined) {
    return createDevWorkspaceRuntime({
      sql,
      baseUrl: oauthUrl,
      redirectUri: config.oauthRedirectUri,
      flow: oauth,
      verify,
      rolesFor,
      groups,
      ledger,
      skills: () => skills,
      enforcement,
      drive,
      runner: controlledRunner(createScriptedRunner({ baseUrl: config.llmUrl }), enforcement),
      now,
    });
  }
  return undefined;
})();
const governed = (skill: RegisteredSkill, model: string): RegisteredSkill =>
  withAdmission(controlledSkill(skill, enforcement, groups, model), model);
const skills = createSkillRegistry([
  governed(incidentSkill, config.incident?.model ?? 'gemini'),
  ...(workspace ? [governed(workspace.taskSkill, 'gemini')] : []),
  governed(workspace?.skill ?? createMeetingPrepSkill(), 'gemini'),
]);
if (workspace !== undefined) {
  await publishBundledCapabilities(suspensionLedger, [
    {
      pin: { kind: 'skill', id: 'meeting-prep', version: '1.0.0' },
      reason: 'Bundled workspace skill',
    },
    {
      pin: { kind: 'skill', id: 'workspace-task', version: '1.0.0' },
      reason: 'Bundled workspace task skill',
    },
    ...workspaceManifests
      .filter((manifest) => manifest.metadata.name !== 'gmail.send')
      .map((manifest) => ({
        pin: {
          kind: 'tool' as const,
          id: manifest.metadata.name,
          version: manifest.metadata.version,
        },
        reason: 'Bundled workspace tool',
      })),
  ]);
}
const dispatch = createPostgresDispatchPort(sql, now);
const worker = createTaskDispatcher({
  dispatch,
  ledger,
  registry: skills,
  approvals: createPostgresApprovalStore(sql),
  now,
  reconcile:
    config.incident === undefined ? undefined : createTicketReconciler(config.incident.ticketsUrl),
  onError: () => console.error('task dispatcher operation failed'),
});
const routines = await prepareRoutines(sql, process.env, now);
const scheduling = await createScheduleRuntime({
  guardAuthority: routines?.guard,
  sql,
  verify,
  dispatch,
  ledger,
  skills,
  suspension: enforcement,
  groups,
  now,
  configurationPath: process.env.AW_SCHEDULE_CONFIG,
});
const routineService = routines?.bind(scheduling);
const internal =
  wiring.delivery === undefined ? undefined : await createDeliveryRoutes(sql, wiring.delivery);
const opsDashboard = wiring.opsDashboard
  ? await buildOpsDashboard(sql, { verify, rolesFor, now })
  : undefined;
const background = await buildBackgroundLoops({
  sql,
  wiring,
  now,
  admission,
  routines: routineService,
  queue: wiring.outbox === undefined ? undefined : buildQueuePublisher(wiring.outbox),
  onError: () => console.error('background operation failed'),
});
// Opt-in: only compose.p0.yaml sets WORKBENCH_ENABLED, so other deployments get no tables, routes or poller.
const workbench =
  process.env.WORKBENCH_ENABLED === '1'
    ? await createWorkbenchRuntime(sql, verify, process.env)
    : undefined;
const controlledApp = (deps: Parameters<typeof createApp>[0]) =>
  controlledListener(createApp(deps), enforcement);
const server = createServer(
  controlledApp({
    verify,
    connectors: workspace?.routes,
    schedules: scheduling.routes,
    scheduleEvents: scheduling.events,
    admin: { ledger: suspensionLedger, rolesFor, now },
    outstanding: () => listOutstandingOperations(sql, now()),
    opsDashboard,
    internal,
    telemetry,
    drive,
    skills,
    dispatch,
    runner: controlledRunner(createScriptedRunner({ baseUrl: config.llmUrl }), enforcement),
    audit: createPostgresAuditLog(sql),
    now,
    oauth,
    oauthConnections: { read: createPostgresOAuthConnectionsReader(sql), now },
    approvals: { store: createPostgresApprovalStore(sql) },
    workbench: workbench?.route,
    wire: {
      groups: (caller) => groups(caller.sub),
      ledger,
      policyInput: async (caller, context, resource) => {
        await authorizeResource(resource?.manifest, config.incident?.model ?? 'gemini');
        const capability = taskSkillPolicy(
          resource?.manifest,
          context.allowedSources,
          workspace !== undefined,
        );
        callers.set(context, caller);
        return Promise.resolve({
          facts: {
            approved_agent_and_skill_version: capability.published,
            agent_has_tool_capability: capability.tools,
            user_or_service_has_resource_authority: context.userSubject === caller.sub,
            source_system_allows_operation: capability.sources,
            data_classification_policy_allows: context.classificationCeiling === 'INTERNAL',
            valid_approval_if_required: true,
            within_time_and_budget_bounds: true,
          },
        });
      },
      search: {
        async search(context, question) {
          const caller = callers.get(context);
          if (caller === undefined) throw new ContextMismatch();
          await beforeReadTool();
          const scope = await drive.open(caller);
          return scope.port.search(context, question);
        },
      },
    },
  }),
).listen(config.port, '0.0.0.0');

worker.start();
scheduling.worker.start();
workbench?.start();
for (const loop of background) loop.start();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await scheduling.worker.stop();
  await Promise.all(background.map((loop) => loop.stop()));
  await workbench?.stop();
  await closed;
  await sql.end({ timeout: 5 });
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
