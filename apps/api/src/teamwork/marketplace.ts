import {
  CONNECTOR_CATALOG,
  MCP_SERVER_CATALOG,
  findConnector,
  findMcpServer,
} from '@agent-works/domain/connector-catalog';
import { WRITE_CAPABILITIES, compareSemver } from '@agent-works/domain/connector-cdk';
import {
  installationViewSchema,
  marketplaceDetailSchema,
  marketplaceListingSchema,
} from '@agent-works/domain/marketplace';

import { listTemplates } from './catalog.js';
import { Conflict, audit } from './context.js';
import {
  bootstrapInstallations,
  findInstallable,
  getInstallation,
  listInstallations,
  unwiredMcpServer,
  updateInstallation,
} from './installations.js';

import type { Deps, Member } from './context.js';
import type { Installation } from './installations.js';
import type { ManifestLookup } from './runtime-manager.js';
import type { ConnectorManifest } from '@agent-works/domain/connector-cdk';
import type {
  ConnectorAction,
  InstallationView,
  MarketplaceDetail,
  MarketplaceKind,
  MarketplaceListing,
} from '@agent-works/domain/marketplace';
import type { Capability, TemplateView } from '@agent-works/domain/teamwork';

/** Audits the refusal under `outcome` (the error code unless a caller names another) and throws. */
type Refuse = (error: Conflict, outcome?: string) => Promise<never>;
type VersionMove = {
  readonly row: Installation;
  readonly input: Extract<ConnectorAction, { action: 'upgrade' | 'rollback' }>;
  readonly manifests: ManifestLookup;
  readonly refuse: Refuse;
};

/** Segment-relative web path of the existing template flow; web prefixes the segment. */
const TEMPLATE_FLOW_HREF = '/catalog';

const COMING_SOON = {
  mcp_server: {
    id: 'mcp-servers',
    name: 'MCP servers',
    summary: 'Connect Model Context Protocol servers. Not available yet; nothing can be enabled.',
  },
  a2a_agent: {
    id: 'a2a-agents',
    name: 'A2A agents',
    summary: 'Delegate to agents over A2A. Not available yet; nothing can be enabled.',
  },
} as const;

function installationView(row: Installation): InstallationView {
  return installationViewSchema.parse({
    connector: row.item_id,
    version: row.version,
    previousVersion: row.previous_version,
    capabilities: row.capabilities,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    observedDetail: row.observed_detail,
    generation: row.generation,
    updatedAt: row.updated_at.toISOString(),
  });
}

type InstallableKind = Extract<MarketplaceKind, 'connector' | 'mcp_server'>;

function connectorListing(
  manifest: ConnectorManifest,
  row: Installation | undefined,
  kind: InstallableKind = 'connector',
): MarketplaceListing {
  return marketplaceListingSchema.parse({
    kind,
    id: manifest.id,
    version: manifest.version,
    name: manifest.displayName,
    summary: manifest.summary,
    publisher: manifest.publisher,
    status: row === undefined ? 'available' : row.desired_state,
  });
}

/** Team bots are a projection: the template stays in the teamwork catalog and the listing links to it. */
function teamBotListing(template: TemplateView): MarketplaceListing {
  return marketplaceListingSchema.parse({
    kind: 'team_bot',
    id: template.id,
    version: `${template.version}.0.0`,
    name: template.definition.name,
    summary: template.definition.role,
    publisher: 'agent-works',
    status: 'available',
    href: TEMPLATE_FLOW_HREF,
  });
}

function comingSoonListing(kind: keyof typeof COMING_SOON): MarketplaceListing {
  // eslint-disable-next-line security/detect-object-injection
  const entry = COMING_SOON[kind];
  return marketplaceListingSchema.parse({
    kind,
    ...entry,
    version: '0.0.0',
    publisher: 'agent-works',
    status: 'coming_soon',
  });
}

export async function listMarketplace(
  deps: Deps,
  member: Member,
  kind: MarketplaceKind | undefined,
): Promise<readonly MarketplaceListing[]> {
  const wants = (candidate: MarketplaceKind) => kind === undefined || kind === candidate;
  const listings: MarketplaceListing[] = [];
  if (wants('connector')) {
    const rows = new Map((await listInstallations(deps)).map((row) => [row.item_id, row]));
    listings.push(
      ...CONNECTOR_CATALOG.map((manifest) => connectorListing(manifest, rows.get(manifest.id))),
    );
  }
  if (wants('team_bot'))
    listings.push(
      ...(await listTemplates(deps, member)).map((template) => teamBotListing(template)),
    );
  if (wants('mcp_server')) {
    if (MCP_SERVER_CATALOG.length === 0 || deps.mcp === undefined)
      listings.push(comingSoonListing('mcp_server'));
    else {
      const rows = new Map((await listInstallations(deps)).map((row) => [row.item_id, row]));
      listings.push(
        ...MCP_SERVER_CATALOG.map((manifest) =>
          connectorListing(manifest, rows.get(manifest.id), 'mcp_server'),
        ),
      );
    }
  }
  if (wants('a2a_agent')) listings.push(comingSoonListing('a2a_agent'));
  return listings;
}

/** An MCP server is shown with the connector-shaped detail: same capabilities and installation. */
async function connectorDetail(
  deps: Deps,
  kind: InstallableKind,
  id: string,
): Promise<MarketplaceDetail | undefined> {
  const manifest = kind === 'connector' ? findConnector(id) : findMcpServer(id);
  if (manifest === undefined) return undefined;
  const row = await getInstallation(deps, id);
  const active = row?.desired_state === 'enabled';
  return marketplaceDetailSchema.parse({
    kind,
    listing: connectorListing(manifest, row, kind),
    capabilities: manifest.capabilities.map((capability) => ({
      id: capability.id,
      access: WRITE_CAPABILITIES.has(capability.id) ? 'write' : 'read',
      tools: capability.tools.map((tool) => tool.metadata.name),
      requiredScopes: capability.requiredScopes,
      allowedByEnv: deps.config.capabilities.has(capability.id),
      enabled: active && row.capabilities.includes(capability.id),
    })),
    installation: row === undefined ? null : installationView(row),
  });
}

export async function marketplaceItem(
  deps: Deps,
  member: Member,
  kind: MarketplaceKind,
  id: string,
): Promise<MarketplaceDetail | undefined> {
  if (kind === 'connector') return connectorDetail(deps, kind, id);
  if (kind === 'mcp_server' && MCP_SERVER_CATALOG.length > 0 && deps.mcp !== undefined)
    return connectorDetail(deps, kind, id);
  if (kind === 'team_bot') {
    const template = (await listTemplates(deps, member)).find((candidate) => candidate.id === id);
    if (template === undefined) return undefined;
    return marketplaceDetailSchema.parse({
      kind,
      listing: teamBotListing(template),
      role: template.definition.role,
      capabilityRequests: template.definition.capabilityRequests,
    });
  }
  // eslint-disable-next-line security/detect-object-injection
  if (COMING_SOON[kind].id !== id) return undefined;
  const listing = comingSoonListing(kind);
  return marketplaceDetailSchema.parse(
    kind === 'a2a_agent'
      ? { kind, listing }
      : { kind, listing, capabilities: [], installation: null },
  );
}

export async function listConnectorInstallations(deps: Deps): Promise<readonly InstallationView[]> {
  return (await listInstallations(deps)).map((row) => installationView(row));
}

/** A segment that never bootstrapped this connector gets its env-derived row first; it is idempotent. */
async function installedRow(deps: Deps, id: string): Promise<Installation | undefined> {
  const row = await getInstallation(deps, id);
  if (row !== undefined) return row;
  await bootstrapInstallations(deps);
  return getInstallation(deps, id);
}

/**
 * A row left from before the gate may still be disabled. Nothing else changes an MCP server while
 * `Deps.mcp` is unwired.
 */
async function refuseWhileUnwired(
  deps: Deps,
  id: string,
  input: ConnectorAction,
  refuse: Refuse,
): Promise<void> {
  if (unwiredMcpServer(deps, id) && input.action !== 'disable')
    await refuse(new Conflict('connector_not_available', 409), 'not_available');
}

/**
 * Admin mutation; the caller has already run `requireAdmin`. The enabled set must sit inside the
 * manifest and the segment env allowlist, so enabling a read capability can never add a write one,
 * and the write is a compare-and-swap on `generation`.
 */
export async function mutateConnector(
  deps: Deps,
  member: Member,
  id: string,
  input: ConnectorAction,
  manifests: ManifestLookup = findInstallable,
): Promise<InstallationView> {
  const manifest = manifests(id);
  if (manifest === undefined) throw new Conflict('not_found', 404);
  const allowed = new Set<Capability>(
    manifest.capabilities
      .map((capability) => capability.id)
      .filter((cap) => deps.config.capabilities.has(cap)),
  );
  const refuse: Refuse = async (error, outcome = error.code) => {
    await audit(deps, deps.sql, {
      ownerSub: member.sub,
      action: `installation.${input.action}`,
      outcome,
      detail: { connector: id, actor: member.email },
    });
    throw error;
  };
  await refuseWhileUnwired(deps, id, input, refuse);
  const row = await installedRow(deps, id);
  if (row === undefined)
    return refuse(new Conflict('connector_not_available', 409), 'not_available');
  if (input.action === 'upgrade' || input.action === 'rollback')
    return moveVersion(deps, member, { row, input, manifests, refuse });

  const requested = 'capabilities' in input ? input.capabilities : undefined;
  const outside = requested?.filter((capability) => !allowed.has(capability)) ?? [];
  if (outside.length > 0)
    return refuse(new Conflict('capability_not_allowed', 400, outside.join(', ')));

  const desiredState =
    input.action === 'disable' ? 'disabled' : input.action === 'enable' ? 'enabled' : undefined;
  const next = await updateInstallation(deps, {
    id,
    expectedGeneration: input.expectedGeneration,
    actor: member.email,
    action: `installation.${input.action}`,
    change: { desiredState, capabilities: requested },
  });
  if (next === undefined) return refuse(new Conflict('stale_generation'));
  return installationView(next);
}

/**
 * The version rules for a move: an upgrade must not go backwards, and the target must be a catalog
 * version that still offers every enabled capability.
 */
async function resolveTarget(move: VersionMove, target: string): Promise<ConnectorManifest> {
  const { row, input, manifests, refuse } = move;
  if (input.action === 'upgrade' && compareSemver(target, row.version) < 0)
    return refuse(new Conflict('not_an_upgrade'));
  const manifest = manifests(row.item_id, target);
  if (manifest === undefined) return refuse(new Conflict('unknown_version', 400));
  const offered = new Set<Capability>(manifest.capabilities.map((capability) => capability.id));
  if (row.capabilities.some((capability) => !offered.has(capability)))
    return refuse(new Conflict('capability_not_in_version'));
  return manifest;
}

/**
 * Upgrade and rollback move `version` between catalog versions and leave the runtime to the
 * reconciler. `previous_version` always names the version a rollback returns to, so a failed
 * upgrade stays reversible, and repeating a move is harmless: a stale generation is a 409 and an
 * upgrade to the installed version changes nothing.
 */
async function moveVersion(
  deps: Deps,
  member: Member,
  move: VersionMove,
): Promise<InstallationView> {
  const { row, input, refuse } = move;
  const target = input.action === 'upgrade' ? input.version : row.previous_version;
  if (input.action === 'upgrade' && target === row.version) return installationView(row);
  if (input.expectedGeneration !== row.generation) return refuse(new Conflict('stale_generation'));
  if (target === null) return refuse(new Conflict('no_previous_version'));
  const manifest = await resolveTarget(move, target);

  const next = await updateInstallation(deps, {
    id: row.item_id,
    expectedGeneration: input.expectedGeneration,
    actor: member.email,
    action: `installation.${input.action}`,
    change: {
      version: target,
      previousVersion: input.action === 'upgrade' ? row.version : null,
      // An in-process connector has nothing to deploy; only a runtime-backed one waits for the reconciler.
      observedState: manifest.runtime === undefined ? 'not_required' : 'pending',
      observedDetail: null,
    },
  });
  if (next === undefined) return refuse(new Conflict('stale_generation'));
  return installationView(next);
}
