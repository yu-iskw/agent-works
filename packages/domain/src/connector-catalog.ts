import { connectorContentHash, connectorManifestSchema } from './connector-cdk.js';

import type { ToolManifest } from './broker.js';
import type { ConnectorManifest } from './connector-cdk.js';
import type { Capability } from './teamwork.js';

function tool(
  name: string,
  capability: Capability,
  sideEffect: ToolManifest['spec']['sideEffect'],
  description: string,
): ToolManifest {
  const read = sideEffect === 'READ';
  return {
    apiVersion: 'internal.agents/v1',
    kind: 'ToolDefinition',
    metadata: { name, version: '1.0.0', owner: 'workspace-integrations' },
    spec: {
      description,
      executor: `connector://${name}`,
      inputSchemaRef: `connectors/${name}`,
      sideEffect,
      dataClassificationMax: 'CONFIDENTIAL',
      lifecycle: 'PUBLISHED',
      permissions: {
        workloadCapability: capability,
        userAuthority: 'delegated',
        resourceConstraint: 'caller-scoped provider ACL',
      },
      approval: { required: !read, policy: read ? 'none' : 'segment-publish-v1' },
      execution: { timeoutSeconds: 30, retries: read ? 2 : 0, idempotency: 'required' },
      evidence: {
        logRequestDigest: true,
        logExternalObjectId: true,
        redactFields: ['query', 'content'],
      },
    },
  };
}

const google: ConnectorManifest = {
  id: 'google',
  version: '1.0.0',
  displayName: 'Google Workspace',
  summary: 'Read Drive files and run BigQuery queries; publish approved briefs as Google Docs.',
  publisher: 'agent-works',
  capabilities: [
    {
      id: 'drive.read',
      tools: [tool('drive.read', 'drive.read', 'READ', 'Read Drive files the member can open')],
      requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    {
      id: 'bigquery.query',
      tools: [tool('bigquery.query', 'bigquery.query', 'READ', 'Run a read-only BigQuery query')],
      requiredScopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    },
    {
      id: 'docs.publish',
      tools: [
        tool(
          'docs.publish',
          'docs.publish',
          'WRITE_LOW',
          'Publish an approved brief as a Google Doc',
        ),
      ],
      requiredScopes: ['https://www.googleapis.com/auth/drive.file'],
    },
  ],
};

const github: ConnectorManifest = {
  id: 'github',
  version: '1.0.0',
  displayName: 'GitHub',
  summary: 'Read repository content the member can access.',
  publisher: 'agent-works',
  capabilities: [
    {
      id: 'github.read',
      tools: [tool('github.read', 'github.read', 'READ', 'Read GitHub repository content')],
      requiredScopes: [],
    },
  ],
};

/** First-party manifests, compiled from code: there is no catalog table and no third-party publishing. */
export const CONNECTOR_CATALOG: readonly ConnectorManifest[] = [google, github].map((manifest) =>
  connectorManifestSchema.parse(manifest),
);

/**
 * Pinned content hash per published version. Changing a manifest without bumping its version fails
 * `connector-catalog.test.ts`; a new version adds a line here, an existing line never changes.
 */
export const PUBLISHED_CONNECTOR_HASHES: Readonly<Record<string, string>> = {
  'google@1.0.0': '78267e1d575805ce43db4eaced62a97b83c93965cd011721edd7e0abd4b86300',
  'github@1.0.0': '4e3f9b8b64261253bad80358f6496deaa78e97060a9f67793496a4d79bb0da77',
};

export function findConnector(id: string, version?: string): ConnectorManifest | undefined {
  return CONNECTOR_CATALOG.find(
    (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
  );
}

export function publishedConnectorHash(manifest: ConnectorManifest): string | undefined {
  return PUBLISHED_CONNECTOR_HASHES[`${manifest.id}@${manifest.version}`];
}

export { connectorContentHash };
