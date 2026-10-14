import { createMeetingPrepSkill } from '../skills/meeting-prep.js';

import { createWorkspaceBroker } from './broker.js';
import { createCalendarAdapter } from './calendar/adapter.js';
import { createWorkspaceCredentials } from './credentials.js';
import { createDocsAdapter } from './docs/adapter.js';
import { createGmailAdapter } from './gmail/adapter.js';
import { createGoogleHttp } from './google-http.js';
import { workspaceRoutes } from './routes.js';

import type { WorkspaceBrokerDeps } from './broker.js';
import type { CredentialDeps } from './credentials.js';
import type { GoogleHttpOptions } from './google-http.js';
import type { WorkspaceRouteDeps } from './routes.js';
import type { MeetingPrepDeps } from '../skills/meeting-prep.js';
export type WorkspaceRuntimeDeps = {
  readonly endpoints: {
    readonly docs: GoogleHttpOptions;
    readonly calendar: GoogleHttpOptions;
    readonly gmail: GoogleHttpOptions;
  };
  readonly credentials: CredentialDeps;
  readonly broker: Omit<WorkspaceBrokerDeps, 'adapters' | 'credentials'>;
  readonly routes: Omit<
    WorkspaceRouteDeps,
    'broker' | 'approvals' | 'now' | 'credentials' | 'approverAuthorized'
  >;
  readonly meeting: Pick<MeetingPrepDeps, 'driveSearch' | 'draft'>;
};
/** There is no implicit environment configuration or credential fallback. */
export function createWorkspaceRuntime(deps: WorkspaceRuntimeDeps) {
  const adapters = {
    docs: createDocsAdapter(createGoogleHttp(deps.endpoints.docs)),
    calendar: createCalendarAdapter(createGoogleHttp(deps.endpoints.calendar)),
    gmail: createGmailAdapter(createGoogleHttp(deps.endpoints.gmail)),
  };
  const credentials = createWorkspaceCredentials(deps.credentials);
  const broker = createWorkspaceBroker({ ...deps.broker, adapters, credentials });
  const routes = workspaceRoutes({
    ...deps.routes,
    broker,
    approvals: deps.broker.approvals,
    credentials: deps.credentials.credentials,
    now: deps.broker.now,
    approverAuthorized: deps.broker.approverAuthorized,
  });
  const skill = createMeetingPrepSkill(() => ({
    ...deps.meeting,
    broker,
    approvals: deps.broker.approvals,
    now: deps.broker.now,
  }));
  return { broker, routes, skill };
}
