import * as z from 'zod';

const roleGroups = [
  { role: 'Employee', group: 'agent-users@company.example' },
  { role: 'Reviewer', group: 'agent-reviewers@company.example' },
  { role: 'Admin', group: 'agent-admins@company.example' },
] as const;

export type AppRole = (typeof roleGroups)[number]['role'];

const maxSnapshotAgeMs = 300_000;
const futureSkewMs = 30_000;
const defaultTimeoutMs = 2_000;

const snapshotSchema = z.strictObject({
  sub: z.string().min(1),
  groups: z.array(z.string().min(1)),
  observedAt: z.iso.datetime(),
});

type GroupSnapshot = z.infer<typeof snapshotSchema>;

export function createRoleResolver(options: {
  readonly baseUrl: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): (sub: string) => Promise<readonly AppRole[]> {
  const baseUrl = new URL(options.baseUrl);
  const clock = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  return async (sub) => {
    const snapshot = await fetchSnapshot(baseUrl, sub, timeoutMs);
    if (snapshot === undefined) return [];
    return rolesAt(snapshot, clock());
  };
}

async function fetchSnapshot(
  baseUrl: URL,
  sub: string,
  timeoutMs: number,
): Promise<GroupSnapshot | undefined> {
  let body: unknown;
  try {
    const response = await fetch(new URL(`/snapshots/${encodeURIComponent(sub)}`, baseUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  }
  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success || parsed.data.sub !== sub) return undefined;
  return parsed.data;
}

function rolesAt(snapshot: GroupSnapshot, nowMs: number): readonly AppRole[] {
  const ageMs = nowMs - Date.parse(snapshot.observedAt);
  const fresh = ageMs >= -futureSkewMs && ageMs <= maxSnapshotAgeMs;
  if (!fresh) return [];
  const held = new Set(snapshot.groups);
  return roleGroups.filter(({ group }) => held.has(group)).map(({ role }) => role);
}
