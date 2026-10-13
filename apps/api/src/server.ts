import { createServer } from 'node:http';

import { createScriptedRunner } from './agent/scripted-runner.js';
import { createApp } from './app.js';
import { createPostgresAuditLog } from './audit/write.js';
import { createGroupResolver } from './auth/directory.js';
import { createIapVerifier } from './auth/iap.js';
import { createPostgresApprovalStore } from './broker/approvals.js';
import { loadConfig } from './config.js';
import { createOAuthFlow } from './credentials/flow.js';
import { createPostgresCredentialStore } from './credentials/postgres.js';
import { createHttpOAuthProvider } from './credentials/provider.js';
import { openDatabase } from './db.js';
import { createPostgresDispatchPort } from './ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from './ledger/postgres-ledger.js';
import { createHttpDrive } from './retrieval/http-drive.js';
import { ContextMismatch } from './retrieval/search.js';
import { createPostgresOAuthConnectionsReader } from './routes/oauth-connections-read.js';
import { createIncidentSkill } from './skills/incident.js';
import { createSkillRegistry } from './skills/registry.js';
import { createTaskDispatcher } from './skills/task-dispatcher.js';
import { createTicketReconciler } from './skills/ticket-receipts.js';

import type { Caller } from './auth/iap.js';
import type { SearchContext } from '@agent-works/domain';

const config = loadConfig(process.env);
const sql = await openDatabase(config.databaseUrl);
const now = () => new Date();
const drive = createHttpDrive({ baseUrl: config.driveUrl, directoryUrl: config.directoryUrl, now });
const groups = createGroupResolver({ baseUrl: config.directoryUrl });
const ledger = createPostgresLedgerPort(sql, now);
const oauthUrl = process.env.OAUTH_URL;
const oauth =
  oauthUrl === undefined
    ? undefined
    : createOAuthFlow({
        ...createPostgresCredentialStore(sql),
        provider: createHttpOAuthProvider(oauthUrl, config.oauthRedirectUri),
        ledger,
        now,
      });
const callers = new WeakMap<SearchContext, Caller>();
const skills = createSkillRegistry([
  createIncidentSkill(() => {
    if (config.incident === undefined) return undefined;
    const runner = createScriptedRunner({ baseUrl: config.llmUrl, model: config.incident.model });
    return {
      ...config.incident,
      model: { answer: async (question) => (await runner.run({ question, sources: [] })).answer },
    };
  }),
]);

const dispatch = createPostgresDispatchPort(sql, now);
const worker = createTaskDispatcher({
  dispatch,
  ledger,
  registry: skills,
  now,
  reconcile:
    config.incident === undefined ? undefined : createTicketReconciler(config.incident.ticketsUrl),
  onError: () => console.error('task dispatcher operation failed'),
});
const server = createServer(
  createApp({
    verify: createIapVerifier(config.iap),
    drive,
    skills,
    dispatch,
    runner: createScriptedRunner({ baseUrl: config.llmUrl }),
    audit: createPostgresAuditLog(sql),
    now,
    oauth,
    oauthConnections: { read: createPostgresOAuthConnectionsReader(sql), now },
    approvals: { store: createPostgresApprovalStore(sql) },
    wire: {
      groups: (caller) => groups(caller.sub),
      ledger,
      policyInput: (caller, context, resource) => {
        const incident = resource?.manifest.id === 'incident-analysis';
        callers.set(context, caller);
        return Promise.resolve({
          facts: {
            approved_agent_and_skill_version:
              resource === undefined || (incident && resource.manifest.state === 'PUBLISHED'),
            agent_has_tool_capability:
              resource === undefined ||
              (incident && resource.manifest.tools.every((tool) => tool === 'ticket.create')),
            user_or_service_has_resource_authority: context.userSubject === caller.sub,
            source_system_allows_operation: incident
              ? context.allowedSources.length > 0 &&
                context.allowedSources.every((source) => source === 'incidents')
              : context.allowedSources.includes('drive'),
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
          const scope = await drive.open(caller);
          return scope.port.search(context, question);
        },
      },
    },
  }),
).listen(config.port, '0.0.0.0');

worker.start();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await closed;
  await sql.end({ timeout: 5 });
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
