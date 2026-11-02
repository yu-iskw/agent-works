import { findConnector } from '@agent-works/domain/connector-catalog';
import { CAPABILITY_PROVIDER, capabilitySchema } from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { audit } from './context.js';

import type { Deps } from './context.js';
import type { Capability } from '@agent-works/domain/teamwork';

export const BOOTSTRAP_ACTOR = 'system:bootstrap';

const installationRowSchema = z.strictObject({
  item_kind: z.literal('connector'),
  item_id: z.string(),
  version: z.string(),
  previous_version: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  desired_state: z.enum(['enabled', 'disabled']),
  observed_state: z.enum([
    'pending',
    'provisioning',
    'healthy',
    'failed',
    'disabled',
    'not_required',
  ]),
  observed_detail: z.string().nullable(),
  generation: z.number().int(),
  updated_by: z.string(),
  updated_at: z.date(),
});

export type Installation = z.infer<typeof installationRowSchema>;

export async function listInstallations(deps: Deps): Promise<readonly Installation[]> {
  const rows = await deps.sql`select * from tw_installations order by item_id`;
  return rows.map((row) => installationRowSchema.parse({ ...row }));
}

export async function getInstallation(deps: Deps, id: string): Promise<Installation | undefined> {
  const rows = await deps.sql`
    select * from tw_installations where item_kind = 'connector' and item_id = ${id}
  `;
  const row = rows.at(0);
  return row === undefined ? undefined : installationRowSchema.parse({ ...row });
}

/**
 * The env allowlist narrowed by activation, read on every call so an admin change applies without a
 * restart. A provider with no row keeps its env capabilities (a segment that has not bootstrapped
 * yet behaves as before); a row only ever removes. `files.read` has no provider and stays env-only.
 */
export async function segmentCapabilities(deps: Deps): Promise<ReadonlySet<Capability>> {
  const rows = await listInstallations(deps);
  const byProvider = new Map(rows.map((row) => [row.item_id, row]));
  return new Set(
    [...deps.config.capabilities].filter((capability) => {
      // eslint-disable-next-line security/detect-object-injection
      const provider = CAPABILITY_PROVIDER[capability];
      if (provider === null) return true;
      const row = byProvider.get(provider);
      return (
        row === undefined ||
        (row.desired_state === 'enabled' && row.capabilities.includes(capability))
      );
    }),
  );
}

/**
 * Upgrade path: one enabled row per env-allowed provider keeps today's behavior, and an admin's
 * later disable persists because a row that exists is never rewritten here.
 */
export async function bootstrapInstallations(deps: Deps): Promise<void> {
  const providers = new Set(
    [...deps.config.capabilities].flatMap((capability) => {
      // eslint-disable-next-line security/detect-object-injection
      const provider = CAPABILITY_PROVIDER[capability];
      return provider === null ? [] : [provider];
    }),
  );
  for (const provider of providers) {
    const manifest = findConnector(provider);
    if (manifest === undefined) continue;
    const capabilities = [...deps.config.capabilities].filter(
      // eslint-disable-next-line security/detect-object-injection
      (capability) => CAPABILITY_PROVIDER[capability] === provider,
    );
    await deps.sql.begin(async (tx) => {
      const inserted = await tx`
        insert into tw_installations (item_kind, item_id, version, capabilities, desired_state,
          observed_state, updated_by, updated_at)
        values ('connector', ${provider}, ${manifest.version}, ${tx.json(capabilities)}, 'enabled',
          'not_required', ${BOOTSTRAP_ACTOR}, ${deps.now()})
        on conflict (item_kind, item_id) do nothing
        returning item_id
      `;
      if (inserted.length === 0) return;
      await audit(deps, tx, {
        ownerSub: null,
        action: 'installation.bootstrap',
        outcome: 'ok',
        detail: { connector: provider, version: manifest.version, actor: BOOTSTRAP_ACTOR },
      });
    });
  }
}

export type InstallationChange = {
  readonly version?: string;
  readonly previousVersion?: string | null;
  readonly capabilities?: readonly Capability[];
  readonly desiredState?: 'enabled' | 'disabled';
  readonly observedState?: Installation['observed_state'];
  readonly observedDetail?: string | null;
};

/**
 * Compare-and-swap on `generation`: returns the new row, or `undefined` when the row is missing or
 * the caller's generation is stale (the caller reports 409). The audit row commits with the write.
 */
export async function updateInstallation(
  deps: Deps,
  input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly actor: string;
    readonly action: string;
    readonly change: InstallationChange;
  },
): Promise<Installation | undefined> {
  const { change } = input;
  return deps.sql.begin(async (tx) => {
    const rows = await tx`
      update tw_installations set
        version = coalesce(${change.version ?? null}, version),
        previous_version = case when ${change.previousVersion !== undefined}
          then ${change.previousVersion ?? null} else previous_version end,
        capabilities = coalesce(${change.capabilities === undefined ? null : tx.json([...change.capabilities])}, capabilities),
        desired_state = coalesce(${change.desiredState ?? null}, desired_state),
        observed_state = coalesce(${change.observedState ?? null}, observed_state),
        observed_detail = case when ${change.observedDetail !== undefined}
          then ${change.observedDetail ?? null} else observed_detail end,
        generation = generation + 1,
        updated_by = ${input.actor},
        updated_at = ${deps.now()}
      where item_kind = 'connector' and item_id = ${input.id}
        and generation = ${input.expectedGeneration}
      returning *
    `;
    const row = rows.at(0);
    if (row === undefined) return undefined;
    const installation = installationRowSchema.parse({ ...row });
    await audit(deps, tx, {
      ownerSub: null,
      action: input.action,
      outcome: 'ok',
      detail: { connector: input.id, actor: input.actor, generation: installation.generation },
    });
    return installation;
  });
}
