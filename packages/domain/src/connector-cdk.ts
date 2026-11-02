import * as z from 'zod';

import { toolManifestSchema } from './broker.js';
import { canonicalPayloadSha256 } from './canonical-hash.js';
import { CAPABILITY_PROVIDER, capabilitySchema } from './teamwork.js';

import type { ToolManifest } from './broker.js';
import type { Capability } from './teamwork.js';

const label = z.string().trim().min(1).max(256);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const semverSchema = z.string().regex(SEMVER);

/** Capabilities that may change external state; every other capability is read-only. */
export const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set(['docs.publish']);

export const connectorProviderSchema = z.enum(['google', 'github']);

export const connectorCapabilitySchema = z.strictObject({
  id: capabilitySchema,
  tools: z.array(toolManifestSchema).min(1),
  requiredScopes: z.array(label),
});

export const connectorManifestSchema = z
  .strictObject({
    id: connectorProviderSchema,
    version: semverSchema,
    displayName: label,
    summary: label,
    publisher: z.literal('agent-works'),
    capabilities: z.array(connectorCapabilitySchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const capabilityIds = new Set<string>();
    const toolNames = new Set<string>();
    manifest.capabilities.forEach((capability, index) => {
      const issue = (message: string, path: (string | number)[] = []) =>
        ctx.addIssue({ code: 'custom', message, path: ['capabilities', index, ...path] });
      if (CAPABILITY_PROVIDER[capability.id] !== manifest.id)
        issue(`capability ${capability.id} does not belong to provider ${manifest.id}`, ['id']);
      if (capabilityIds.has(capability.id)) issue(`duplicate capability ${capability.id}`, ['id']);
      capabilityIds.add(capability.id);
      const write = WRITE_CAPABILITIES.has(capability.id);
      capability.tools.forEach((tool, toolIndex) => {
        const name = tool.metadata.name;
        const toolIssue = (message: string) => issue(message, ['tools', toolIndex]);
        if (toolNames.has(name)) toolIssue(`duplicate tool name ${name}`);
        toolNames.add(name);
        if (!write && tool.spec.sideEffect !== 'READ')
          toolIssue(`tool ${name} has side effect ${tool.spec.sideEffect} under read capability`);
        if (write && tool.spec.sideEffect === 'READ')
          toolIssue(`read-only tool ${name} under write capability`);
      });
    });
  });

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** Digest of the parsed manifest; the catalog pins one per published version so a version stays immutable. */
export function connectorContentHash(manifest: ConnectorManifest): string {
  return canonicalPayloadSha256(connectorManifestSchema.parse(manifest));
}

export function connectorToolManifests(manifest: ConnectorManifest): readonly ToolManifest[] {
  return manifest.capabilities.flatMap((capability) => capability.tools);
}

export type ConnectorRegistry<H> = ReadonlyMap<
  string,
  { readonly manifest: ToolManifest; readonly handler: H }
>;

/** Binds one handler to every tool manifest; a duplicate, missing, or extra handler is a definition error. */
export function defineRegistry<H>(
  tools: readonly ToolManifest[],
  handlers: Readonly<Record<string, H>>,
): ConnectorRegistry<H> {
  const parsed = tools.map((tool) => toolManifestSchema.parse(tool));
  const names = new Set<string>();
  const duplicates: string[] = [];
  for (const tool of parsed) {
    if (names.has(tool.metadata.name)) duplicates.push(tool.metadata.name);
    names.add(tool.metadata.name);
  }
  if (duplicates.length > 0) throw new Error(`duplicate tool names [${duplicates.join(', ')}]`);
  const provided = Object.keys(handlers);
  const missing = [...names].filter((name) => !Object.hasOwn(handlers, name));
  const extra = provided.filter((name) => !names.has(name));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      `handler mismatch: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  return new Map(
    parsed.map((tool) => [
      tool.metadata.name,
      { manifest: tool, handler: handlers[tool.metadata.name] as H },
    ]),
  );
}

/** Binds one handler to every manifest tool; a missing or extra handler is a definition error. */
export function defineConnector<H>(
  manifest: ConnectorManifest,
  handlers: Readonly<Record<string, H>>,
): ConnectorRegistry<H> {
  const parsed = connectorManifestSchema.parse(manifest);
  return defineRegistry(connectorToolManifests(parsed), handlers);
}
