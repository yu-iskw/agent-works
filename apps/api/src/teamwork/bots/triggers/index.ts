import { randomUUID } from 'node:crypto';

import { botDefinitionSchema } from '@agent-works/domain';
import * as z from 'zod';

import { verifyEventSignature } from '../../../scheduling/signature.js';
import { dueSlot } from '../../../scheduling/time.js';
import { audit } from '../../context.js';

import type { StartBotRun } from './types.js';
import type { SigningKey } from '../../../scheduling/keys.js';
import type { SignedEvent } from '../../../scheduling/signature.js';
import type { Deps, Request, Reply } from '../../context.js';
import type { BotDefinition, ScheduleSpec } from '@agent-works/domain';
import type postgres from 'postgres';

type ActiveBot = {
  teammate_id: string;
  owner_sub: string;
  revision: number;
  definition: unknown;
  published_at: Date;
};
type ScheduleTrigger = Extract<BotDefinition['triggers'][number], { kind: 'schedule' }>;
type RunOutcome = 'started' | 'duplicate' | 'ignored' | 'deferred';
type EventRun = { teammateId: string; outcome: RunOutcome; taskId?: string };
export type IngestResult = { outcome: RunOutcome; runs: EventRun[] };
export type TickReport = {
  started: number;
  duplicate: number;
  denied: number;
  deferred: number;
  missedDueToCapacity: number;
};
type Dependencies = {
  sql: postgres.Sql;
  now: () => Date;
  startBotRun: StartBotRun;
  signingKeys: (source: string) => SigningKey | undefined;
  log: unknown;
};
const metadata = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\r\n]+$/);
const eventSchema = z.strictObject({
  triggerId: metadata,
  source: metadata,
  eventId: metadata,
  timestamp: metadata,
  keyId: metadata,
  signature: z.string().min(1).max(32768),
  body: z.strictObject({
    type: z.literal('Buffer'),
    data: z.array(z.number().int().min(0).max(255)).max(16384),
  }),
});
const allDay = { weekdays: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' };
function spec(trigger: ScheduleTrigger): ScheduleSpec {
  // dueSlot reads only these scheduling fields.
  return {
    timing: trigger.timing,
    timezone: trigger.timezone,
    allowedWindow: trigger.allowedWindow ?? allDay,
    expiresAt: '9999-12-31T23:59:59.999Z',
    misfire: trigger.missedRun === 'skip' ? 'skip' : 'catch-up-once',
  } as ScheduleSpec;
}
function activeBots(sql: postgres.Sql) {
  return sql<
    ActiveBot[]
  >`select b.teammate_id, b.owner_sub, r.revision, r.definition, r.published_at from tw_bots b join tw_bot_revisions r on r.teammate_id = b.teammate_id and r.revision = b.active_revision where r.state = 'published'`;
}
function validateEvent(event: SignedEvent, deps: Dependencies): unknown {
  if (!Buffer.isBuffer(event.body) || event.body.length > 16384) throw new Error('invalid_event');
  const key = deps.signingKeys(event.source);
  if (!key) throw new Error('invalid_signature');
  try {
    verifyEventSignature(event, key);
  } catch {
    throw new Error('invalid_signature');
  }
  const timestamp = Date.parse(event.timestamp);
  const now = deps.now().getTime();
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== event.timestamp ||
    timestamp > now ||
    now - timestamp > 300000
  )
    throw new Error('invalid_signature');
  try {
    return JSON.parse(event.body.toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_event');
  }
}
export function createBotTriggers(deps: Dependencies) {
  const auditDeps = { now: deps.now } as Deps;
  async function tick(): Promise<TickReport> {
    const report: TickReport = {
      started: 0,
      duplicate: 0,
      denied: 0,
      deferred: 0,
      missedDueToCapacity: 0,
    };
    for (const bot of await activeBots(deps.sql)) {
      const definition = botDefinitionSchema.parse(bot.definition);
      for (const [index, trigger] of definition.triggers.entries()) {
        if (trigger.kind !== 'schedule') continue;
        await deps.sql.begin(async (tx) => {
          await tx`insert into tw_bot_trigger_cursors (teammate_id, revision, trigger_index, cursor_at) values (${bot.teammate_id}, ${bot.revision}, ${index}, ${bot.published_at}) on conflict do nothing`;
          const [cursor] = await tx<
            { cursor_at: Date; pending_at: Date | null }[]
          >`select cursor_at, pending_at from tw_bot_trigger_cursors where teammate_id = ${bot.teammate_id} and revision = ${bot.revision} and trigger_index = ${index} for update`;
          const active =
            await tx`select 1 from tw_bots where teammate_id = ${bot.teammate_id} and active_revision = ${bot.revision}`;
          if (active.length === 0) return;
          const now = deps.now();
          const timing = spec(trigger);
          let slot = cursor.pending_at?.toISOString();
          if (slot) {
            const next = dueSlot(
              { ...timing, allowedWindow: allDay, misfire: 'catch-up-once' },
              slot,
              now,
            );
            if (next && now.getTime() > Date.parse(next)) {
              report.missedDueToCapacity++;
              await audit(auditDeps, tx, {
                ownerSub: bot.owner_sub,
                action: 'bot.trigger.schedule',
                outcome: 'missed_due_to_capacity',
                detail: { revision: bot.revision, triggerIndex: index, slot },
              });
              slot = dueSlot(timing, cursor.cursor_at.toISOString(), now);
            }
          } else slot = dueSlot(timing, cursor.cursor_at.toISOString(), now);
          let pending: string | null = null;
          if (slot) {
            const ref = `schedule:${bot.revision}:${index}:${slot}`;
            const result = await deps.startBotRun({
              teammateId: bot.teammate_id,
              trigger: { kind: 'schedule', ref, scheduledFor: slot },
              initiatedBy: `schedule:${bot.teammate_id}`,
              clientRequestId: randomUUID(),
            });
            report[result.kind]++;
            if (result.kind === 'deferred') pending = slot;
            await audit(auditDeps, tx, {
              ownerSub: bot.owner_sub,
              taskId:
                result.kind === 'started' || result.kind === 'duplicate' ? result.taskId : null,
              action: 'bot.trigger.schedule',
              outcome: result.kind,
              detail: { revision: bot.revision, triggerIndex: index, slot },
            });
          }
          await tx`update tw_bot_trigger_cursors set cursor_at = greatest(cursor_at, ${now}), pending_at = ${pending} where teammate_id = ${bot.teammate_id} and revision = ${bot.revision} and trigger_index = ${index}`;
        });
      }
    }
    return report;
  }
  async function ingest(event: SignedEvent): Promise<IngestResult> {
    let payload: unknown;
    try {
      payload = validateEvent(event, deps);
    } catch (error) {
      await audit(auditDeps, deps.sql, {
        ownerSub: null,
        action: 'bot.trigger.event',
        outcome: error instanceof Error ? error.message : 'invalid_event',
      });
      throw error;
    }
    const runs: EventRun[] = [];
    for (const bot of await activeBots(deps.sql)) {
      const definition = botDefinitionSchema.parse(bot.definition);
      if (
        !definition.triggers.some(
          (trigger) =>
            trigger.kind === 'event' &&
            trigger.source === event.source &&
            trigger.eventType === event.triggerId,
        )
      )
        continue;
      const ref = `event:${event.source}:${event.eventId}`;
      const result = await deps.startBotRun({
        teammateId: bot.teammate_id,
        trigger: { kind: 'event', ref, source: event.source, eventType: event.triggerId, payload },
        initiatedBy: ref,
        clientRequestId: randomUUID(),
      });
      const outcome = result.kind === 'denied' ? 'ignored' : result.kind;
      const taskId =
        result.kind === 'started' || result.kind === 'duplicate' ? result.taskId : undefined;
      runs.push(
        taskId
          ? { teammateId: bot.teammate_id, outcome, taskId }
          : { teammateId: bot.teammate_id, outcome },
      );
      await audit(auditDeps, deps.sql, {
        ownerSub: bot.owner_sub,
        taskId,
        action: 'bot.trigger.event',
        outcome: result.kind,
        detail: { source: event.source, eventId: event.eventId, eventType: event.triggerId },
      });
    }
    const outcome =
      (['started', 'deferred', 'duplicate', 'ignored'] as const).find((value) =>
        runs.some((run) => run.outcome === value),
      ) ?? 'ignored';
    return { outcome, runs };
  }
  async function handleBotEventRequest(
    request: Pick<Request, 'method' | 'path' | 'headers' | 'body'>,
  ): Promise<Reply> {
    if (request.method !== 'POST' || request.path !== '/v1/teamwork/bot-events')
      return { status: 404, body: { error: 'not_found' } };
    if (request.body.length > 100000) return { status: 400, body: { error: 'invalid_event' } };
    let value: unknown;
    try {
      value = JSON.parse(request.body.toString('utf8')) as unknown;
    } catch {
      return { status: 400, body: { error: 'invalid_event' } };
    }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return { status: 400, body: { error: 'invalid_event' } };
    try {
      return {
        status: 202,
        body: await ingest({ ...parsed.data, body: Buffer.from(parsed.data.body.data) }),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'invalid_event' || error.message === 'invalid_signature')
      )
        return {
          status: error.message === 'invalid_event' ? 400 : 401,
          body: { error: error.message },
        };
      throw error;
    }
  }
  return { tick, ingest, handleBotEventRequest };
}
