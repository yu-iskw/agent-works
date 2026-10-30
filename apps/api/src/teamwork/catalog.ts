import { createHash } from 'node:crypto';

import { canonicalPayloadSha256 } from '@agent-works/domain';
import { skillDefinitionSchema, templateDefinitionSchema } from '@agent-works/domain/teamwork';
import { capabilityStates } from '@agent-works/domain/teamwork-policy';
import { inspectPortable, parsePortable, toPortable } from '@agent-works/domain/teamwork-portable';

import { CURATED_SKILLS, CURATED_TEMPLATES, STARTER_SKILLS, curatedFor } from './catalog-seed.js';
import { connectedProviders } from './connections.js';
import { Conflict, audit } from './context.js';

import type { Provider } from './connections.js';
import type { Deps, Member, Tx } from './context.js';
import type {
  Accent,
  AvatarId,
  Capability,
  CapabilityState,
  PortableDefinition,
  SkillDefinition,
  SkillView,
  TeammateRow as TeammateRowView,
  TeammateView,
  TemplateDefinition,
  TemplateView,
} from '@agent-works/domain/teamwork';
import type { PortableFinding } from '@agent-works/domain/teamwork-portable';
import type postgres from 'postgres';

type Db = postgres.Sql | Tx;

/** Deterministic UUID from a namespace and parts, so seeding and starter teams are idempotent. */
function stableUuid(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function seedOne(
  deps: Deps,
  tx: Tx,
  kind: 'skill' | 'template',
  key: string,
  definition: SkillDefinition | TemplateDefinition,
): Promise<void> {
  const contentSha256 = canonicalPayloadSha256(definition);
  const existing = await tx<{ id: string; content_sha256: string }[]>`
    select id, content_sha256 from tw_curated_keys where key = ${`${kind}:${key}`}
  `;
  const row = existing.at(0);
  if (row?.content_sha256 === contentSha256) return;
  const id = row?.id ?? stableUuid(deps.config.segment, kind, key);
  const at = deps.now();
  if (row === undefined) {
    if (kind === 'skill')
      await tx`insert into tw_skills (id, origin, created_at) values (${id}, 'curated', ${at})`;
    else
      await tx`insert into tw_templates (id, origin, created_at) values (${id}, 'curated', ${at})`;
  }
  if (kind === 'skill')
    await tx`
      insert into tw_skill_versions (skill_id, version, definition, created_at)
      select ${id}, coalesce(max(version), 0) + 1, ${tx.json(definition)}, ${at}
      from tw_skill_versions where skill_id = ${id}
    `;
  else
    await tx`
      insert into tw_template_versions (template_id, version, definition, created_at)
      select ${id}, coalesce(max(version), 0) + 1, ${tx.json(definition)}, ${at}
      from tw_template_versions where template_id = ${id}
    `;
  await tx`
    insert into tw_curated_keys (key, kind, id, content_sha256) values (${`${kind}:${key}`}, ${kind}, ${id}, ${contentSha256})
    on conflict (key) do update set content_sha256 = excluded.content_sha256
  `;
}

/** Idempotent: unchanged entries are skipped; a changed entry becomes a new version. */
export async function seedCatalog(deps: Deps): Promise<void> {
  await deps.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7019)`;
    for (const entry of curatedFor(CURATED_SKILLS, deps.config.segment))
      await seedOne(deps, tx, 'skill', entry.key, entry.definition);
    for (const entry of curatedFor(CURATED_TEMPLATES, deps.config.segment))
      await seedOne(deps, tx, 'template', entry.key, entry.definition);
  });
}

type SkillRow = {
  id: string;
  version: number;
  origin: SkillView['origin'];
  owner_sub: string | null;
  derived_from_id: string | null;
  derived_from_version: number | null;
  definition: SkillDefinition;
  created_at: Date;
};

/** Skills a member may see: curated ones and their own private or imported copies. */
async function visibleSkills(db: Db, ownerSub: string, allVersions: boolean): Promise<SkillRow[]> {
  return db<SkillRow[]>`
    select s.id, v.version, s.origin, s.owner_sub, s.derived_from_id, s.derived_from_version,
      v.definition, v.created_at
    from tw_skills s join tw_skill_versions v on v.skill_id = s.id
    where (s.owner_sub is null or s.owner_sub = ${ownerSub})
    ${allVersions ? db`` : db`and v.version = (select max(version) from tw_skill_versions where skill_id = s.id)`}
    order by s.origin, v.definition->>'name', v.version
  `;
}

export async function listSkills(deps: Deps, member: Member): Promise<readonly SkillView[]> {
  const [rows, attached] = await Promise.all([
    visibleSkills(deps.sql, member.sub, false),
    deps.sql<{ skill_id: string; teammate_id: string }[]>`
      select ts.skill_id, ts.teammate_id from tw_teammate_skills ts
      join tw_teammates t on t.id = ts.teammate_id
      where t.owner_sub = ${member.sub} and not t.archived
    `,
  ]);
  return rows.map((row) =>
    skillView(
      row,
      attached.filter((a) => a.skill_id === row.id).map((a) => a.teammate_id),
    ),
  );
}

export async function skillVersions(
  deps: Deps,
  member: Member,
  skillId: string,
): Promise<readonly SkillView[]> {
  const rows = (await visibleSkills(deps.sql, member.sub, true)).filter(
    (row) => row.id === skillId,
  );
  return rows.map((row) => skillView(row, []));
}

function skillView(row: SkillRow, attachedTo: readonly string[]): SkillView {
  return {
    id: row.id,
    version: row.version,
    origin: row.origin,
    derivedFrom:
      row.derived_from_id === null
        ? null
        : { id: row.derived_from_id, version: row.derived_from_version ?? 1 },
    ownerSub: row.owner_sub,
    definition: row.definition,
    createdAt: row.created_at.toISOString(),
    attachedTo: [...attachedTo],
  };
}

export async function listTemplates(deps: Deps, member: Member): Promise<readonly TemplateView[]> {
  const rows = await deps.sql<
    {
      id: string;
      version: number;
      origin: TemplateView['origin'];
      definition: TemplateDefinition;
      created_at: Date;
    }[]
  >`
    select t.id, v.version, t.origin, v.definition, v.created_at
    from tw_templates t join tw_template_versions v on v.template_id = t.id
    where t.origin = 'curated' and (t.owner_sub is null or t.owner_sub = ${member.sub})
      and v.version = (select max(version) from tw_template_versions where template_id = t.id)
    order by v.definition->>'name'
  `;
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    origin: row.origin,
    definition: row.definition,
    createdAt: row.created_at.toISOString(),
  }));
}

type TeammateRow = {
  id: string;
  owner_sub: string;
  origin: TeammateView['origin'];
  template_id: string;
  template_version: number;
  template_name: string;
  name: string;
  role: string;
  instructions: string;
  capability_requests: Capability[];
  version: number;
  conversation_id: string;
  avatar: AvatarId | null;
  accent: Accent | null;
  created_at: Date;
  updated_at: Date;
};

export type TeammateSkill = {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly definition: SkillDefinition;
};

export async function teammateSkills(
  db: Db,
  teammateIds: readonly string[],
): Promise<ReadonlyMap<string, readonly TeammateSkill[]>> {
  if (teammateIds.length === 0) return new Map();
  const rows = await db<
    { teammate_id: string; skill_id: string; skill_version: number; definition: SkillDefinition }[]
  >`
    select ts.teammate_id, ts.skill_id, ts.skill_version, v.definition
    from tw_teammate_skills ts
    join tw_skill_versions v on v.skill_id = ts.skill_id and v.version = ts.skill_version
    where ts.teammate_id = any(${teammateIds as string[]}::uuid[])
    order by ts.attached_at
  `;
  const out = new Map<string, TeammateSkill[]>();
  for (const row of rows) {
    const list = out.get(row.teammate_id) ?? [];
    list.push({
      id: row.skill_id,
      version: row.skill_version,
      name: row.definition.name,
      definition: row.definition,
    });
    out.set(row.teammate_id, list);
  }
  return out;
}

export function memberCapabilities(deps: Deps, member: Member): ReadonlySet<Capability> {
  const readOnly = deps.config.readOnlyMembers.has(member.email);
  return new Set(
    [...deps.config.capabilities].filter(
      (capability) => !(readOnly && capability === 'docs.publish'),
    ),
  );
}

/** `connected` lets a caller that checks several teammates look the member's connections up once. */
export async function capabilitiesFor(
  deps: Deps,
  member: Member,
  requests: readonly Capability[],
  task?: ReadonlySet<Capability>,
  connected?: ReadonlySet<Provider>,
): Promise<readonly CapabilityState[]> {
  return capabilityStates({
    segment: deps.config.capabilities,
    member: memberCapabilities(deps, member),
    teammate: new Set(requests),
    connected: connected ?? (await connectedProviders(deps, member.sub)),
    task,
  });
}

async function teammateRows(db: Db, ownerSub: string, id?: string): Promise<TeammateRow[]> {
  return db<TeammateRow[]>`
    select t.*, v.definition->>'name' as template_name
    from tw_teammates t
    join tw_template_versions v on v.template_id = t.template_id and v.version = t.template_version
    where t.owner_sub = ${ownerSub} and not t.archived ${id === undefined ? db`` : db`and t.id = ${id}`}
    order by t.created_at
  `;
}

async function views(
  deps: Deps,
  member: Member,
  rows: readonly TeammateRow[],
): Promise<TeammateView[]> {
  const skills = await teammateSkills(
    deps.sql,
    rows.map((row) => row.id),
  );
  const connected = await connectedProviders(deps, member.sub);
  const entitled = memberCapabilities(deps, member);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    template: { id: row.template_id, version: row.template_version, name: row.template_name },
    skills: (skills.get(row.id) ?? []).map(({ id, version, name }) => ({ id, version, name })),
    capabilities: [
      ...capabilityStates({
        segment: deps.config.capabilities,
        member: entitled,
        teammate: new Set(row.capability_requests),
        connected,
      }),
    ],
    version: row.version,
    origin: row.origin,
    conversationId: row.conversation_id,
    appearance: { avatar: row.avatar, accent: row.accent },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listTeammates(deps: Deps, member: Member): Promise<readonly TeammateView[]> {
  return views(deps, member, await teammateRows(deps.sql, member.sub));
}

type ActivityRow = {
  id: string;
  last_text: string | null;
  last_at: Date | null;
  last_role: 'member' | 'teammate' | 'system' | null;
  unread: boolean;
  working: boolean;
  needs_attention: boolean;
  unread_result: boolean;
};

const PREVIEW_CHARS = 140;
const preview = (text: string): string =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}\u2026` : text;

/**
 * The sidebar's teammate rows: each teammate with its last message and the three distinct states
 * the member reads at a glance. One query over the member's teammates; a task is linked to a
 * teammate's conversation when it was started there or, lacking one, when the teammate owns it.
 */
export async function listTeammateRows(
  deps: Deps,
  member: Member,
): Promise<readonly TeammateRowView[]> {
  const base = await listTeammates(deps, member);
  if (base.length === 0) return [];
  const activity = await deps.sql<ActivityRow[]>`
    select t.id, lm.body as last_text, lm.created_at as last_at, lm.role as last_role,
      exists (select 1 from tw_messages m where m.conversation_id = t.conversation_id and m.role <> 'member'
        and (r.owner_sub is null or (m.created_at, m.id) > (r.last_read_at, r.last_read_message_id))) as unread,
      (exists (select 1 from wb_tasks k where k.kind = 'teamwork' and k.owner_sub = t.owner_sub
          and (k.conversation_id = t.conversation_id or (k.conversation_id is null and k.result_owner = t.id))
          and k.status in ('planning', 'running', 'synthesizing', 'publishing'))
        or exists (select 1 from tw_assignments a where a.teammate_id = t.id and a.status = 'running')
        or exists (select 1 from tw_messages m where m.conversation_id = t.conversation_id and m.reply_state = 'pending')
      ) as working,
      exists (select 1 from tw_inbox i join wb_tasks k on k.id = i.task_id
        where i.state = 'open' and i.kind in ('question', 'plan_review', 'approval', 'failed', 'uncertain')
          and (k.conversation_id = t.conversation_id or (k.conversation_id is null and k.result_owner = t.id))) as needs_attention,
      exists (select 1 from tw_messages m where m.conversation_id = t.conversation_id and m.card->>'kind' = 'result_ready'
        and (r.owner_sub is null or (m.created_at, m.id) > (r.last_read_at, r.last_read_message_id))) as unread_result
    from tw_teammates t
    left join tw_conversation_reads r on r.owner_sub = t.owner_sub and r.conversation_id = t.conversation_id
    left join lateral (
      select body, created_at, role from tw_messages m where m.conversation_id = t.conversation_id
      order by created_at desc, id desc limit 1
    ) lm on true
    where t.owner_sub = ${member.sub} and not t.archived
  `;
  const byId = new Map(activity.map((row) => [row.id, row]));
  return base.map((teammate) => {
    const row = byId.get(teammate.id);
    return {
      ...teammate,
      lastMessage:
        row?.last_at == null || row.last_text === null || row.last_role === null
          ? null
          : { text: preview(row.last_text), at: row.last_at.toISOString(), role: row.last_role },
      unread: row?.unread ?? false,
      working: row?.working ?? false,
      needsAttention: row?.needs_attention ?? false,
      unreadResult: row?.unread_result ?? false,
    };
  });
}

export async function getTeammate(
  deps: Deps,
  member: Member,
  id: string,
): Promise<TeammateView | undefined> {
  return (await views(deps, member, await teammateRows(deps.sql, member.sub, id))).at(0);
}

async function insertTeammate(
  deps: Deps,
  tx: Tx,
  member: Member,
  input: {
    readonly id: string;
    readonly clientRequestId: string;
    readonly origin: TeammateView['origin'];
    readonly templateId: string;
    readonly templateVersion: number;
    readonly definition: TemplateDefinition;
    readonly name: string;
    readonly skills: readonly { readonly id: string; readonly version: number }[];
  },
): Promise<boolean> {
  const at = deps.now();
  const conversationId = stableUuid(input.id, 'conversation');
  const inserted = await tx`
    insert into tw_teammates (id, owner_sub, client_request_id, origin, template_id, template_version,
      name, role, instructions, capability_requests, version, conversation_id, created_at, updated_at)
    values (${input.id}, ${member.sub}, ${input.clientRequestId}, ${input.origin}, ${input.templateId},
      ${input.templateVersion}, ${input.name}, ${input.definition.role}, ${input.definition.instructions},
      ${tx.json(input.definition.capabilityRequests)}, 1, ${conversationId}, ${at}, ${at})
    on conflict (owner_sub, client_request_id) do nothing
    returning id
  `;
  if (inserted.length === 0) return false;
  await tx`insert into tw_conversations (id, owner_sub, teammate_id, created_at) values (${conversationId}, ${member.sub}, ${input.id}, ${at})`;
  for (const skill of input.skills)
    await tx`
      insert into tw_teammate_skills (teammate_id, skill_id, skill_version, attached_at)
      values (${input.id}, ${skill.id}, ${skill.version}, ${at})
    `;
  return true;
}

async function latestTemplate(db: Db, templateId: string) {
  const rows = await db<
    {
      id: string;
      version: number;
      definition: TemplateDefinition;
      origin: string;
      owner_sub: string | null;
    }[]
  >`
    select t.id, v.version, v.definition, t.origin, t.owner_sub from tw_templates t
    join tw_template_versions v on v.template_id = t.id
    where t.id = ${templateId} order by v.version desc limit 1
  `;
  return rows.at(0);
}

async function starterSkillsFor(db: Db, templateId: string) {
  const keys = await db<
    { key: string }[]
  >`select key from tw_curated_keys where id = ${templateId}`;
  const templateKey = keys.at(0)?.key.replace(/^template:/, '') ?? '';
  // eslint-disable-next-line security/detect-object-injection
  const skillKeys = (STARTER_SKILLS[templateKey] ?? []).map((key) => `skill:${key}`);
  if (skillKeys.length === 0) return [];
  return db<{ id: string; version: number }[]>`
    select k.id, max(v.version)::int as version from tw_curated_keys k
    join tw_skill_versions v on v.skill_id = k.id
    where k.key = any(${skillKeys}::text[]) group by k.id
  `;
}

/** A personal copy of a curated template; the template itself is never modified. */
export async function createTeammate(
  deps: Deps,
  member: Member,
  input: { readonly templateId: string; readonly name?: string; readonly clientRequestId: string },
): Promise<TeammateView> {
  const id = await deps.sql.begin(async (tx) => {
    const template = await latestTemplate(tx, input.templateId);
    if (
      template === undefined ||
      (template.owner_sub !== null && template.owner_sub !== member.sub)
    )
      throw new Conflict('not_found', 404);
    const newId = stableUuid(member.sub, 'teammate', input.clientRequestId);
    await insertTeammate(deps, tx, member, {
      id: newId,
      clientRequestId: input.clientRequestId,
      origin: 'template',
      templateId: template.id,
      templateVersion: template.version,
      definition: template.definition,
      name: input.name ?? template.definition.name,
      skills: await starterSkillsFor(tx, template.id),
    });
    return newId;
  });
  const view = await getTeammate(deps, member, id);
  if (view === undefined) throw new Conflict('not_found', 404);
  return view;
}

/** One personal teammate per curated template; idempotent per member. */
export async function createStarterTeam(
  deps: Deps,
  member: Member,
): Promise<readonly TeammateView[]> {
  const templates = await listTemplates(deps, member);
  for (const template of templates)
    await createTeammate(deps, member, {
      templateId: template.id,
      clientRequestId: stableUuid(member.sub, 'starter', template.id),
    });
  return listTeammates(deps, member);
}

export async function updateTeammate(
  deps: Deps,
  member: Member,
  id: string,
  input: {
    readonly expectedVersion: number;
    readonly name: string;
    readonly role: string;
    readonly instructions: string;
    readonly avatar?: AvatarId | null;
    readonly accent?: Accent | null;
  },
): Promise<TeammateView> {
  const sql = deps.sql;
  const updated = await sql`
    update tw_teammates set name = ${input.name}, role = ${input.role}, instructions = ${input.instructions},
      avatar = ${input.avatar === undefined ? sql`avatar` : input.avatar},
      accent = ${input.accent === undefined ? sql`accent` : input.accent},
      version = version + 1, updated_at = ${deps.now()}
    where id = ${id} and owner_sub = ${member.sub} and version = ${input.expectedVersion} and not archived
    returning id
  `;
  if (updated.length === 0) {
    if ((await teammateRows(deps.sql, member.sub, id)).length === 0)
      throw new Conflict('not_found', 404);
    throw new Conflict('stale_version');
  }
  const view = await getTeammate(deps, member, id);
  if (view === undefined) throw new Conflict('not_found', 404);
  return view;
}

export async function setSkill(
  deps: Deps,
  member: Member,
  teammateId: string,
  input: { readonly skillId: string; readonly version: number; readonly attach: boolean },
): Promise<TeammateView> {
  await deps.sql.begin(async (tx) => {
    const owned =
      await tx`select id from tw_teammates where id = ${teammateId} and owner_sub = ${member.sub} and not archived for update`;
    if (owned.length === 0) throw new Conflict('not_found', 404);
    if (!input.attach) {
      await tx`delete from tw_teammate_skills where teammate_id = ${teammateId} and skill_id = ${input.skillId}`;
    } else {
      const visible = await tx`
        select 1 from tw_skills s join tw_skill_versions v on v.skill_id = s.id
        where s.id = ${input.skillId} and v.version = ${input.version}
          and (s.owner_sub is null or s.owner_sub = ${member.sub})
      `;
      if (visible.length === 0) throw new Conflict('not_found', 404);
      await tx`
        insert into tw_teammate_skills (teammate_id, skill_id, skill_version, attached_at)
        values (${teammateId}, ${input.skillId}, ${input.version}, ${deps.now()})
        on conflict (teammate_id, skill_id) do update set skill_version = excluded.skill_version
      `;
    }
    await tx`update tw_teammates set version = version + 1, updated_at = ${deps.now()} where id = ${teammateId}`;
  });
  const view = await getTeammate(deps, member, teammateId);
  if (view === undefined) throw new Conflict('not_found', 404);
  return view;
}

/**
 * Customizing a curated skill creates the member's own private skill derived from it; customizing
 * their own private skill adds a version. Curated originals and other members' copies never change.
 */
export async function customizeSkill(
  deps: Deps,
  member: Member,
  input: {
    readonly fromSkillId: string;
    readonly fromVersion: number;
    readonly definition: SkillDefinition;
  },
): Promise<SkillView> {
  const definition = skillDefinitionSchema.parse(input.definition);
  const skillId = await deps.sql.begin(async (tx) => {
    const source = await tx<{ id: string; owner_sub: string | null; origin: string }[]>`
      select s.id, s.owner_sub, s.origin from tw_skills s join tw_skill_versions v on v.skill_id = s.id
      where s.id = ${input.fromSkillId} and v.version = ${input.fromVersion}
        and (s.owner_sub is null or s.owner_sub = ${member.sub})
    `;
    const row = source.at(0);
    if (row === undefined) throw new Conflict('not_found', 404);
    const at = deps.now();
    if (row.owner_sub === member.sub) {
      await tx`
        insert into tw_skill_versions (skill_id, version, definition, created_at)
        select ${row.id}, max(version) + 1, ${tx.json(definition)}, ${at} from tw_skill_versions where skill_id = ${row.id}
      `;
      return row.id;
    }
    const id = deps.newId();
    await tx`
      insert into tw_skills (id, origin, owner_sub, derived_from_id, derived_from_version, created_at)
      values (${id}, 'private', ${member.sub}, ${row.id}, ${input.fromVersion}, ${at})
    `;
    await tx`insert into tw_skill_versions (skill_id, version, definition, created_at) values (${id}, 1, ${tx.json(definition)}, ${at})`;
    return id;
  });
  const versions = await skillVersions(deps, member, skillId);
  return versions.at(-1) as SkillView;
}

/** Values that identify this member's private bindings; export must not contain any of them. */
async function knownPrivate(deps: Deps, member: Member): Promise<readonly string[]> {
  const accounts = await deps.sql<
    { account: string }[]
  >`select account from tw_connections where owner_sub = ${member.sub}`;
  const s = deps.config.sources;
  return [
    member.email,
    member.sub,
    ...accounts.map((row) => row.account),
    s.driveResearchFolder,
    s.driveContextFolder,
    s.bigqueryDataset,
    s.bigqueryProject,
  ].filter((value): value is string => value !== undefined && value.length > 0);
}

type ExportPreview = {
  readonly definition: PortableDefinition;
  readonly findings: readonly PortableFinding[];
  readonly json: string;
};

export async function exportTeammate(
  deps: Deps,
  member: Member,
  id: string,
): Promise<ExportPreview> {
  const rows = await teammateRows(deps.sql, member.sub, id);
  const row = rows.at(0);
  if (row === undefined) throw new Conflict('not_found', 404);
  const skills = (await teammateSkills(deps.sql, [row.id])).get(row.id) ?? [];
  const definition = toPortable({
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    capabilityRequests: row.capability_requests,
    skills: skills.map((skill) => skill.definition),
  });
  const findings = inspectPortable(definition, await knownPrivate(deps, member));
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    action: 'teammate.export',
    outcome: findings.length === 0 ? 'clean' : 'findings',
    detail: { findings: findings.length },
  });
  return { definition, findings, json: `${JSON.stringify(definition, null, 2)}\n` };
}

/**
 * Import creates recipient-owned objects only. Requested capabilities stay requests; the
 * recipient's own policy and connections decide what becomes effective.
 */
export async function importTeammate(
  deps: Deps,
  member: Member,
  raw: string,
  clientRequestId: string,
): Promise<{ readonly teammate: TeammateView; readonly capabilities: readonly CapabilityState[] }> {
  const parsed = parsePortable(raw, await knownPrivate(deps, member));
  if (!parsed.ok) throw new Conflict(parsed.error, 400);
  const definition = parsed.definition;
  const id = stableUuid(member.sub, 'import', clientRequestId);
  await deps.sql.begin(async (tx) => {
    const exists =
      await tx`select 1 from tw_teammates where owner_sub = ${member.sub} and client_request_id = ${clientRequestId}`;
    if (exists.length > 0) return;
    const at = deps.now();
    const templateId = deps.newId();
    const template = templateDefinitionSchema.parse({
      name: definition.name,
      role: definition.role,
      instructions: definition.instructions,
      compatibleSkills: definition.skills.map((skill) => skill.name),
      capabilityRequests: definition.capabilityRequests,
    });
    await tx`insert into tw_templates (id, origin, owner_sub, created_at) values (${templateId}, 'imported', ${member.sub}, ${at})`;
    await tx`insert into tw_template_versions (template_id, version, definition, created_at) values (${templateId}, 1, ${tx.json(template)}, ${at})`;
    const skills: { id: string; version: number }[] = [];
    for (const skill of definition.skills) {
      const skillId = deps.newId();
      await tx`insert into tw_skills (id, origin, owner_sub, created_at) values (${skillId}, 'imported', ${member.sub}, ${at})`;
      await tx`insert into tw_skill_versions (skill_id, version, definition, created_at) values (${skillId}, 1, ${tx.json(skill)}, ${at})`;
      skills.push({ id: skillId, version: 1 });
    }
    await insertTeammate(deps, tx, member, {
      id,
      clientRequestId,
      origin: 'imported',
      templateId,
      templateVersion: 1,
      definition: template,
      name: definition.name,
      skills,
    });
    await audit(deps, tx, {
      ownerSub: member.sub,
      action: 'teammate.import',
      outcome: 'created',
      detail: { requested: definition.capabilityRequests.length },
    });
  });
  const teammate = await getTeammate(deps, member, id);
  if (teammate === undefined) throw new Conflict('not_found', 404);
  return { teammate, capabilities: teammate.capabilities };
}
