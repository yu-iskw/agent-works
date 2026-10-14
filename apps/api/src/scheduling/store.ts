import { canonicalPayloadSha256 } from '@agent-works/domain';

import {
  eventTriggerSchema,
  receivedEventSchema,
  sourceEventKey,
} from '../../../../packages/domain/dist/event-trigger.js';
import {
  scheduleRunId,
  scheduleRunSchema,
  scheduleAuditSchema,
} from '../../../../packages/domain/dist/schedule-run.js';
import {
  scheduleHash,
  scheduleSpecSchema,
  scheduleRecordSchema,
} from '../../../../packages/domain/dist/schedule.js';
import { ScheduleConflict } from '../ports/schedule-port.js';

import type { EventTrigger } from '../../../../packages/domain/dist/event-trigger.js';
import type { ScheduleRun, ScheduleAudit } from '../../../../packages/domain/dist/schedule-run.js';
import type { ScheduleSpec, ScheduleRecord } from '../../../../packages/domain/dist/schedule.js';
import type {
  ClaimRun,
  ScheduleDriver,
  SchedulePort,
  ScheduleState,
  RunCompletion,
} from '../ports/schedule-port.js';

export function createSchedulePort(driver: ScheduleDriver): SchedulePort {
  const tx = <T>(operation: (state: ScheduleState) => T) => driver.transaction(operation);
  return {
    create: (spec, actor, at, trigger) => tx((s) => create(s, spec, actor, at, trigger)),
    list: (subject) => tx((s) => s.schedules.filter((v) => v.spec.sponsor.sub === subject)),
    all: () => tx((s) => s.schedules),
    read: (subject, id) =>
      tx((s) => s.schedules.find((v) => v.spec.id === id && v.spec.sponsor.sub === subject)),
    change: (...args: Parameters<SchedulePort['change']>) => {
      const [subject, id, revision, action, at, reason] = args;
      return tx((s) => change(s, { subject, id, revision, action, at, reason }));
    },
    advance: (id, cursor) =>
      tx((s) => {
        const row = requiredSchedule(s, id);
        validInstant(cursor);
        if (Date.parse(cursor) > Date.parse(row.cursor)) row.cursor = cursor;
      }),
    claim: (input) => tx((s) => claim(s, input)),
    finish: (run, result, at) => tx((s) => finish(s, run, result, at)),
    runs: (id) => tx((s) => s.runs.filter((v) => v.scheduleId === id)),
    history: (subject) =>
      tx((s) => {
        const ids = new Set(
          s.schedules.filter((v) => v.spec.sponsor.sub === subject).map((v) => v.spec.id),
        );
        return s.audit.filter((v) => ids.has(v.scheduleId));
      }),
    triggers: (subject) =>
      tx((s) => {
        const ids = new Set(
          s.schedules.filter((v) => v.spec.sponsor.sub === subject).map((v) => v.spec.id),
        );
        return s.triggers.filter((v) => ids.has(v.scheduleId));
      }),
    trigger: (id) => tx((s) => s.triggers.find((v) => v.id === id)),
    eventForRun: (id) => tx((s) => s.events.find((v) => v.runId === id)),
    received: (source, eventId) =>
      tx((s) => s.events.find((v) => v.key === sourceEventKey(source, eventId))),
  };
}
function validInstant(at: string): void {
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
    throw new ScheduleConflict('invalid instant');
}
function requiredSchedule(s: ScheduleState, id: string): ScheduleRecord {
  const row = s.schedules.find((v) => v.spec.id === id);
  if (row === undefined) throw new ScheduleConflict('schedule missing');
  return row;
}
function create(
  s: ScheduleState,
  spec: ScheduleSpec,
  actor: string,
  at: string,
  trigger?: EventTrigger,
): ScheduleRecord {
  spec = scheduleSpecSchema.parse(spec);
  validInstant(at);
  if (spec.sponsor.sub !== actor || Date.parse(spec.expiresAt) <= Date.parse(at))
    throw new ScheduleConflict('invalid sponsor or expiry');
  trigger = validateTrigger(spec, trigger);
  const digest = scheduleHash(spec);
  const prior = s.schedules.find((v) => v.spec.id === spec.id);
  if (prior !== undefined) {
    const old = s.triggers.find((v) => v.scheduleId === spec.id);
    if (
      prior.digest !== digest ||
      canonicalPayloadSha256(old ?? null) !== canonicalPayloadSha256(trigger ?? null)
    )
      throw new ScheduleConflict('schedule id reused');
    return prior;
  }
  if (trigger !== undefined && s.triggers.some((v) => v.id === trigger.id))
    throw new ScheduleConflict('trigger id reused');
  const row = scheduleRecordSchema.parse({
    spec,
    digest,
    state: 'active',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    cursor: at,
  });
  s.schedules.push(row);
  if (trigger !== undefined) s.triggers.push(trigger);
  audit(s, row, 'created', at, { runId: null, reason: null });
  return row;
}
type Change = {
  subject: string;
  id: string;
  revision: number;
  action: 'pause' | 'resume' | 'revoke';
  at: string;
  reason?: string;
};
function change(s: ScheduleState, input: Change): ScheduleRecord {
  const row = requiredSchedule(s, input.id);
  validInstant(input.at);
  if (row.spec.sponsor.sub !== input.subject || row.revision !== input.revision)
    throw new ScheduleConflict('stale revision or owner');
  if (row.state === 'revoked') throw new ScheduleConflict('revocation permanent');
  if (input.action === 'resume' && Date.parse(row.spec.expiresAt) <= Date.parse(input.at))
    throw new ScheduleConflict('expired');
  row.state =
    input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'revoked';
  row.revision += 1;
  row.updatedAt = input.at;
  if (input.action === 'resume') row.cursor = input.at;
  audit(
    s,
    row,
    input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'resumed' : 'revoked',
    input.at,
    { runId: null, reason: input.reason ?? null },
  );
  return row;
}
function claim(s: ScheduleState, input: ClaimRun): ScheduleRun | undefined {
  validInstant(input.now);
  validInstant(input.fireAt);
  validateLease(input);
  const row = requiredSchedule(s, input.scheduleId);
  if (
    row.state !== 'active' ||
    Date.parse(row.spec.expiresAt) <= Date.parse(input.now) ||
    Date.parse(input.fireAt) > Date.parse(input.now)
  )
    return undefined;
  const event = input.event === null ? null : receivedEventSchema.parse(input.event);
  const id = scheduleRunId(row.spec.id, input.fireAt, event?.key ?? null);
  if (event !== null) validateEvent(s, event, input, id);
  const prior = s.runs.find((v) => v.id === id);
  if (prior !== undefined) return takeOver(prior, input);
  const run = scheduleRunSchema.parse({
    id,
    scheduleId: row.spec.id,
    fireAt: input.fireAt,
    status: 'dispatching',
    taskId: null,
    reason: null,
    leaseOwner: input.owner,
    leaseUntil: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
    fence: 1,
    createdAt: input.now,
    updatedAt: input.now,
    eventKey: event?.key ?? null,
  });
  s.runs.push(run);
  if (event !== null) {
    s.events.push(event);
    audit(s, row, 'event-received', input.now, { runId: run.id, reason: null });
  }
  audit(s, row, 'claimed', input.now, { runId: run.id, reason: null });
  return run;
}
function validateEvent(
  s: ScheduleState,
  event: NonNullable<ClaimRun['event']>,
  input: ClaimRun,
  id: string,
): void {
  const trigger = s.triggers.find((v) => v.id === event.triggerId);
  if (
    trigger === undefined ||
    trigger.scheduleId !== input.scheduleId ||
    event.scheduleId !== input.scheduleId ||
    trigger.source !== event.source ||
    event.key !== sourceEventKey(event.source, event.eventId) ||
    event.runId !== id
  )
    throw new ScheduleConflict('event mismatch');
  const prior = s.events.find((v) => v.key === event.key);
  if (prior !== undefined && (prior.digest !== event.digest || prior.runId !== id))
    throw new ScheduleConflict('source event replay');
}
function finish(
  s: ScheduleState,
  claim: ScheduleRun,
  result: RunCompletion,
  at: string,
): ScheduleRun {
  validInstant(at);
  const run = s.runs.find((v) => v.id === claim.id);
  const row = requiredSchedule(s, claim.scheduleId);
  if (run === undefined || run.fence !== claim.fence || run.leaseOwner !== claim.leaseOwner)
    throw new ScheduleConflict('stale run fence');
  if (run.status === result.status && run.taskId === result.taskId && run.reason === result.reason)
    return run;
  const valid =
    run.status === 'dispatching' ||
    (run.status === 'accepted' && ['cancelled', 'completed'].includes(result.status));
  if (!valid) throw new ScheduleConflict('terminal run');
  if (result.status === 'accepted' && result.taskId === null)
    throw new ScheduleConflict('accepted task required');
  const parsed = scheduleRunSchema.parse({ ...run, ...result, updatedAt: at });
  Object.assign(run, parsed);
  audit(s, row, result.status, at, { runId: run.id, reason: result.reason });
  return run;
}
function audit(
  s: ScheduleState,
  row: ScheduleRecord,
  kind: ScheduleAudit['kind'],
  at: string,
  evidence: { runId: string | null; reason: string | null },
): void {
  const { runId, reason } = evidence;
  const id = canonicalPayloadSha256({
    scheduleId: row.spec.id,
    revision: row.revision,
    kind,
    runId,
  });
  s.audit.push(
    scheduleAuditSchema.parse({
      id,
      scheduleId: row.spec.id,
      actorSub: row.spec.sponsor.sub,
      at,
      kind,
      runId,
      reason,
      digest: row.digest,
    }),
  );
}

function validateTrigger(
  spec: ScheduleSpec,
  trigger: EventTrigger | undefined,
): EventTrigger | undefined {
  if (trigger === undefined) return undefined;
  const parsed = eventTriggerSchema.parse(trigger);
  if (parsed.scheduleId !== spec.id) throw new ScheduleConflict('trigger schedule mismatch');
  return parsed;
}

function validateLease(input: ClaimRun): void {
  if (
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1 ||
    input.leaseMs > 300000 ||
    input.owner.length === 0
  )
    throw new ScheduleConflict('invalid lease');
}

function takeOver(prior: ScheduleRun, input: ClaimRun): ScheduleRun | undefined {
  if (prior.status !== 'dispatching' || Date.parse(prior.leaseUntil) > Date.parse(input.now))
    return undefined;
  prior.leaseOwner = input.owner;
  prior.leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
  prior.fence += 1;
  prior.updatedAt = input.now;
  return prior;
}
