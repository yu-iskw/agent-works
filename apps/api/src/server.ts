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
import { createPostgresLedgerPort } from './ledger/postgres-ledger.js';
import { createHttpDrive } from './retrieval/http-drive.js';
import { ContextMismatch } from './retrieval/search.js';

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

createServer(
  createApp({
    verify: createIapVerifier(config.iap),
    drive,
    runner: createScriptedRunner({ baseUrl: config.llmUrl }),
    audit: createPostgresAuditLog(sql),
    now,
    oauth,
    approvals: { store: createPostgresApprovalStore(sql) },
    wire: {
      groups: (caller) => groups(caller.sub),
      ledger,
      policyInput: (caller, context) => {
        callers.set(context, caller);
        return Promise.resolve({
          facts: {
            approved_agent_and_skill_version: true,
            agent_has_tool_capability: true,
            user_or_service_has_resource_authority: context.userSubject === caller.sub,
            source_system_allows_operation: context.allowedSources.includes('drive'),
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
