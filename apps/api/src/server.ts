import { createServer } from 'node:http';

import { workspaceManifests } from '@agent-works/domain/workspace-tools';

import { createScriptedRunner } from './agent/scripted-runner.js';
import { createApp } from './app.js';
import { createPostgresAuditLog } from './audit/write.js';
import { createRoleResolver, createGroupResolver } from './auth/directory.js';
import { createIapVerifier } from './auth/iap.js';
import { createPostgresApprovalStore } from './broker/approvals.js';
import { loadConfig } from './config.js';
import { createDevWorkspaceRuntime } from './connectors/dev-runtime.js';
import { createOAuthFlow } from './credentials/flow.js';
import { createPostgresCredentialStore } from './credentials/postgres.js';
import { createHttpOAuthProvider } from './credentials/provider.js';
import { openDatabase } from './db.js';
import { createPostgresDispatchPort } from './ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from './ledger/postgres-ledger.js';
import { createHttpDrive } from './retrieval/http-drive.js';
import { ContextMismatch } from './retrieval/search.js';
import { createPostgresOAuthConnectionsReader } from './routes/oauth-connections-read.js';
import { createScheduleRuntime } from './scheduling/runtime.js';
import { createIncidentSkill } from './skills/incident.js';
import { createMeetingPrepSkill } from './skills/meeting-prep.js';
import { createSkillRegistry } from './skills/registry.js';
import { createTaskDispatcher } from './skills/task-dispatcher.js';
import { taskSkillPolicy } from './skills/task-policy.js';
import { createTicketReconciler } from './skills/ticket-receipts.js';
import { publishBundledCapabilities } from './suspension/bootstrap.js';
import { createSuspensionEnforcer } from './suspension/enforcement.js';
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

import type { Caller } from './auth/iap.js';
import type { SearchContext } from '@agent-works/domain';

const config = loadConfig(process.env);
const sql = await openDatabase(config.databaseUrl);
const now = () => new Date();
const drive = createHttpDrive({
  baseUrl: config.driveUrl,
  directoryUrl: config.directoryUrl,
  workerToken: process.env.AW_DEV_STACK === '1' ? process.env.DRIVE_WORKER_TOKEN : undefined,
  now,
});
const groups = createGroupResolver({ baseUrl: config.directoryUrl });
const ledger = createPostgresLedgerPort(sql, now);
const suspensionLedger = createPostgresSuspensionLedger(sql);
const rolesFor = createRoleResolver({ baseUrl: config.directoryUrl });
const oauthUrl = process.env.OAUTH_URL;
const oauth =
  oauthUrl === undefined
    ? undefined
    : createOAuthFlow({
        ...createPostgresCredentialStore(sql),
        provider: createHttpOAuthProvider(
          oauthUrl,
          config.oauthRedirectUri,
          process.env.OAUTH_PUBLIC_URL,
        ),
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
});
const verify = controlledVerify(createIapVerifier(config.iap), groups, enforcement);
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
const skills = createSkillRegistry([
  controlledSkill(incidentSkill, enforcement, groups, config.incident?.model ?? 'gemini'),
  ...(workspace ? [controlledSkill(workspace.taskSkill, enforcement, groups, 'gemini')] : []),
  controlledSkill(workspace?.skill ?? createMeetingPrepSkill(), enforcement, groups, 'gemini'),
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
const scheduling = await createScheduleRuntime({
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
const controlledApp = (deps: Parameters<typeof createApp>[0]) =>
  controlledListener(createApp(deps), enforcement);
const server = createServer(
  controlledApp({
    verify,
    connectors: workspace?.routes,
    schedules: scheduling.routes,
    scheduleEvents: scheduling.events,
    admin: { ledger: suspensionLedger, rolesFor, now },
    drive,
    skills,
    dispatch,
    runner: controlledRunner(createScriptedRunner({ baseUrl: config.llmUrl }), enforcement),
    audit: createPostgresAuditLog(sql),
    now,
    oauth,
    oauthConnections: { read: createPostgresOAuthConnectionsReader(sql), now },
    approvals: { store: createPostgresApprovalStore(sql) },
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
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await scheduling.worker.stop();
  await closed;
  await sql.end({ timeout: 5 });
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
