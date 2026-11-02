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

/** A tool served over MCP: the wire name equals the manifest name, and writes need an MCP approval policy. */
function mcpTool(
  server: string,
  name: string,
  capability: Capability,
  sideEffect: ToolManifest['spec']['sideEffect'],
  description: string,
): ToolManifest {
  const base = tool(name, capability, sideEffect, description);
  const read = sideEffect === 'READ';
  return {
    ...base,
    spec: {
      ...base.spec,
      executor: `mcp://${server}/${name}`,
      approval: { required: !read, policy: read ? 'none' : 'mcp-write-v1' },
      execution: { timeoutSeconds: 10, retries: read ? 2 : 0, idempotency: 'required' },
    },
  };
}

const DRIVE_READ = 'drive.read';
const BIGQUERY_QUERY = 'bigquery.query';
const DOCS_PUBLISH = 'docs.publish';
const GITHUB_READ = 'github.read';
const NOTES_READ = 'notes.read';
const NOTES_WRITE = 'notes.write';
const PUBLISHER = 'agent-works';

const google: ConnectorManifest = {
  id: 'google',
  version: '1.0.0',
  displayName: 'Google Workspace',
  summary: 'Read Drive files and run BigQuery queries; publish approved briefs as Google Docs.',
  publisher: PUBLISHER,
  capabilities: [
    {
      id: DRIVE_READ,
      tools: [tool(DRIVE_READ, DRIVE_READ, 'READ', 'Read Drive files the member can open')],
      requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    {
      id: BIGQUERY_QUERY,
      tools: [tool(BIGQUERY_QUERY, BIGQUERY_QUERY, 'READ', 'Run a read-only BigQuery query')],
      requiredScopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    },
    {
      id: DOCS_PUBLISH,
      tools: [
        tool(DOCS_PUBLISH, DOCS_PUBLISH, 'WRITE_LOW', 'Publish an approved brief as a Google Doc'),
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
  publisher: PUBLISHER,
  capabilities: [
    {
      id: GITHUB_READ,
      tools: [tool(GITHUB_READ, GITHUB_READ, 'READ', 'Read GitHub repository content')],
      requiredScopes: [],
    },
  ],
};

const notes: ConnectorManifest = {
  id: 'notes',
  version: '1.0.0',
  displayName: 'Team notes (MCP)',
  summary: 'Search team notes and, with approval, append to them over MCP.',
  publisher: PUBLISHER,
  transport: 'mcp',
  capabilities: [
    {
      id: NOTES_READ,
      tools: [mcpTool('notes', 'notes.search', NOTES_READ, 'READ', 'Search team notes')],
      requiredScopes: [],
    },
    {
      id: NOTES_WRITE,
      tools: [mcpTool('notes', 'notes.append', NOTES_WRITE, 'WRITE_LOW', 'Append to a team note')],
      requiredScopes: [],
    },
  ],
};

/** First-party manifests, compiled from code: there is no catalog table and no third-party publishing. */
export const CONNECTOR_CATALOG: readonly ConnectorManifest[] = [google, github].map((manifest) =>
  connectorManifestSchema.parse(manifest),
);

/**
 * First-party MCP tool servers. Kept apart from `CONNECTOR_CATALOG` so the gateway registry and the
 * connector listing stay native-only until an MCP server is wired in on purpose.
 */
export const MCP_SERVER_CATALOG: readonly ConnectorManifest[] = [notes].map((manifest) =>
  connectorManifestSchema.parse(manifest),
);

/**
 * Pinned content hash per published version. Changing a manifest without bumping its version fails
 * `connector-catalog.test.ts`; a new version adds a line here, an existing line never changes.
 */
export const PUBLISHED_CONNECTOR_HASHES: Readonly<Record<string, string>> = {
  'google@1.0.0': '78267e1d575805ce43db4eaced62a97b83c93965cd011721edd7e0abd4b86300',
  'github@1.0.0': '4e3f9b8b64261253bad80358f6496deaa78e97060a9f67793496a4d79bb0da77',
  'notes@1.0.0': '492d120862f68eeda3aa462d6b5300a89227e3d01ae17e7729dba51a37c88d7e',
};

export function findConnector(id: string, version?: string): ConnectorManifest | undefined {
  return CONNECTOR_CATALOG.find(
    (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
  );
}

export function findMcpServer(id: string, version?: string): ConnectorManifest | undefined {
  return MCP_SERVER_CATALOG.find(
    (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
  );
}

export function publishedConnectorHash(manifest: ConnectorManifest): string | undefined {
  return PUBLISHED_CONNECTOR_HASHES[`${manifest.id}@${manifest.version}`];
}

export { connectorContentHash };
