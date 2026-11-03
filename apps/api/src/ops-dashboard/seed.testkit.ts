import { execFileSync } from 'node:child_process';

import type { OpsPrincipal } from './types.js';
import type { Sql } from 'postgres';

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    try {
      execFileSync('test', ['-x', '/usr/lib/postgresql/16/bin/initdb']);
      return true;
    } catch {
      return false;
    }
  }
}

export const NOW = '2026-11-03T11:00:00.000Z';
export const WINDOW = { from: '2026-11-03T09:00:00.000Z', to: '2026-11-03T12:00:00.000Z' };
/** Execution ids are 64 hex characters because schedule_runs requires it. */
export const exec = (n: number): string => n.toString(16).padStart(64, '0');

type Seed = {
  n: number;
  fire: string;
  outboxAfterMs: number;
  outbox: 'pending' | 'published';
  worker: 'queued' | 'succeeded';
  attempts: number;
  owner: [member: string, bot: string, segment: string];
  state: 'succeeded' | 'failed';
  estimated: number;
  cost: number;
};

const SEEDS: readonly Seed[] = [
  {
    n: 1,
    fire: '10:00:00',
    outboxAfterMs: 2000,
    outbox: 'published',
    worker: 'succeeded',
    attempts: 1,
    owner: ['m1', 'b1', 's1'],
    state: 'succeeded',
    estimated: 1000,
    cost: 900,
  },
  {
    n: 2,
    fire: '10:01:00',
    outboxAfterMs: 4000,
    outbox: 'pending',
    worker: 'queued',
    attempts: 2,
    owner: ['m1', 'b1', 's1'],
    state: 'failed',
    estimated: 500,
    cost: 500,
  },
  {
    n: 3,
    fire: '10:02:00',
    outboxAfterMs: 6000,
    outbox: 'published',
    worker: 'succeeded',
    attempts: 3,
    owner: ['m2', 'b2', 's1'],
    state: 'succeeded',
    estimated: 2000,
    cost: 2000,
  },
  {
    n: 4,
    fire: '10:03:00',
    outboxAfterMs: 8000,
    outbox: 'published',
    worker: 'succeeded',
    attempts: 1,
    owner: ['m3', 'b3', 's2'],
    state: 'succeeded',
    estimated: 700,
    cost: 700,
  },
];

/** Four executions across two teams with known latency, retries, backlog and cost. Needs a fresh database. */
export async function seedLedger(sql: Sql): Promise<void> {
  const scheduleId = '00000000-0000-4000-8000-000000000001';
  await sql`insert into schedules(id, sponsor_sub, revision, state, expires_at, payload)
    values (${scheduleId}, 'sponsor', 1, 'active', '2027-01-01T00:00:00Z', '{}')`;
  for (const s of SEEDS) {
    const id = exec(s.n);
    const fire = `2026-11-03T${s.fire}.000Z`;
    const outboxAt = new Date(Date.parse(fire) + s.outboxAfterMs).toISOString();
    await sql`insert into schedule_runs(id, schedule_id, fire_at, status, fence, lease_until, task_id, payload)
      values (${id}, ${scheduleId}, ${fire}, 'accepted', 1, ${fire}, 't', '{}')`;
    await sql`insert into dispatch_outbox(dispatch_id, execution_id, target_kind, transport_name, envelope, state, next_attempt_at, created_at, published_at)
      values (${`dsp:${id}`}, ${id}, 'cloud-tasks-http', ${`d-${id}`}, '{}', ${s.outbox}, ${outboxAt}, ${outboxAt},
        ${s.outbox === 'published' ? outboxAt : null})`;
    await sql`insert into worker_executions(execution_id, state, attempts, max_attempts, next_attempt_at, deadline_at, result_digest, created_at, updated_at)
      values (${id}, ${s.worker}, ${s.attempts}, 5, ${fire}, '2026-11-04T00:00:00Z',
        ${s.worker === 'succeeded' ? id : null}, ${fire}, ${fire})`;
    await sql`insert into admission_reservations(execution_id, member_id, bot_id, segment_id, window_key, state, estimated_cost_micros, cost_micros, created_at, expires_at, finished_at)
      values (${id}, ${s.owner[0]}, ${s.owner[1]}, ${s.owner[2]}, 'w1', ${s.state}, ${s.estimated}, ${s.cost}, ${fire}, ${fire}, ${fire})`;
  }
}

export const principal = (overrides: Partial<OpsPrincipal> = {}): OpsPrincipal => ({
  subject: 'sub-m1',
  memberId: 'm1',
  ownedBotIds: [],
  adminSegmentIds: [],
  platformAdmin: false,
  ...overrides,
});
