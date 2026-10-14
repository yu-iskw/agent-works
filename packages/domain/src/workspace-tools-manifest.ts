import { toolManifestSchema } from './broker.js';
import { workspaceToolNames } from './workspace-tools-scopes.js';

import type { WorkspaceToolName } from './workspace-tools-scopes.js';

const sendTool = 'gmail.send';
export function workspaceManifest(name: WorkspaceToolName) {
  const read = name === 'calendar.listEvents' || name === 'gmail.searchThreads';
  return toolManifestSchema.parse({
    apiVersion: 'internal.agents/v1',
    kind: 'ToolDefinition',
    metadata: { name, version: '1.0.0', owner: 'workspace-integrations' },
    spec: {
      description: name === sendTool ? 'Denied external send capability' : `Offline ${name}`,
      executor: `fake://google/${name}`,
      inputSchemaRef: `workspace/${name}`,
      sideEffect: name === sendTool ? 'EXTERNAL_SEND' : read ? 'READ' : 'WRITE_LOW',
      dataClassificationMax: 'CONFIDENTIAL',
      lifecycle: 'PUBLISHED',
      permissions: {
        workloadCapability: name,
        userAuthority: 'delegated',
        resourceConstraint: 'caller-scoped Google ACL',
      },
      approval: {
        required: !read,
        policy: name === sendTool ? 'default-deny' : 'workspace-payload-v1',
      },
      execution: { timeoutSeconds: 10, retries: 2, idempotency: 'required' },
      evidence: {
        logRequestDigest: true,
        logExternalObjectId: true,
        redactFields: ['body', 'description', 'query', 'to', 'attendees'],
      },
    },
  });
}
export const workspaceManifests = workspaceToolNames.map(workspaceManifest);
export function workspaceToolRef(name: WorkspaceToolName): string {
  return `${name}@1.0.0`;
}
