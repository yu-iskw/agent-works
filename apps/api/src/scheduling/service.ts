import { taskAcceptedSchema } from '@agent-works/domain';

import { eventTriggerSchema } from '../../../../packages/domain/dist/event-trigger.js';
import { scheduleHash, scheduleSpecSchema } from '../../../../packages/domain/dist/schedule.js';
import { ScheduleConflict } from '../ports/schedule-port.js';
import { InvocationStopped } from '../suspension/enforcement.js';

import { admit } from './admission.js';
import { checkAuthority, ScheduleDenied } from './authority.js';
import { dueSlot, inAllowedWindow } from './time.js';

import type { AdmissionDeps } from './admission.js';
import type { ScheduleCancel } from './cancel.js';
import type {
  EventTrigger,
  ReceivedEvent,
} from '../../../../packages/domain/dist/event-trigger.js';
import type { ScheduleRun } from '../../../../packages/domain/dist/schedule-run.js';
import type { ScheduleSpec, ScheduleRecord } from '../../../../packages/domain/dist/schedule.js';
import type { DispatchPort } from '../ports/dispatch-port.js';
import type { SchedulePort } from '../ports/schedule-port.js';
import type { LocalEngine } from '../workflow/local-engine.js';
import type { TaskStatus } from '@agent-works/domain';
export type SchedulerDeps = AdmissionDeps & {
  engine: Pick<LocalEngine, 'run'>;
  store: SchedulePort;
  dispatch: Pick<DispatchPort, 'accept'>;
  cancel: ScheduleCancel;
  now: () => Date;
  owner: string;
  findTask: (subject: string, idempotencyKey: string) => Promise<string | undefined>;
  taskStatus: (subject: string, taskId: string) => Promise<TaskStatus | undefined>;
};
export type Scheduler = {
  create(spec: ScheduleSpec, actor: string, trigger?: EventTrigger): Promise<ScheduleRecord>;
  change(
    subject: string,
    id: string,
    revision: number,
    action: 'pause' | 'resume' | 'revoke',
  ): Promise<ScheduleRecord>;
  tick(): Promise<void>;
  fireEvent(event: ReceivedEvent): Promise<ScheduleRun | undefined>;
};
export function createScheduler(deps: SchedulerDeps): Scheduler {
  return {
    async create(spec, actor, trigger) {
      spec = scheduleSpecSchema.parse(spec);
      if (spec.sponsor.sub !== actor) throw new ScheduleDenied('SPONSOR_MISMATCH');
      const now = deps.now();
      if (Date.parse(spec.expiresAt) <= now.getTime()) throw new ScheduleDenied('EXPIRED');
      if (trigger !== undefined) eventTriggerSchema.parse(trigger);
      await checkAuthority(spec, scheduleHash(spec), now, deps);
      return deps.store.create(spec, actor, now.toISOString(), trigger);
    },
    async change(subject, id, revision, action) {
      const prior = await deps.store.read(subject, id);
      if (prior === undefined) throw new ScheduleConflict('schedule missing');
      if (action === 'resume') await checkAuthority(prior.spec, prior.digest, deps.now(), deps);
      const row = await deps.store.change(subject, id, revision, action, deps.now().toISOString());
      if (action !== 'resume')
        await cancelRuns(deps, row, action === 'pause' ? 'SCHEDULE_PAUSED' : 'SCHEDULE_REVOKED');
      return row;
    },
    async tick() {
      for (const row of await deps.store.all()) await tickSchedule(deps, row);
    },
    async fireEvent(event) {
      const row = (await deps.store.all()).find((v) => v.spec.id === event.scheduleId);
      if (row === undefined) throw new ScheduleDenied('TRIGGER_MISSING');
      if (
        row.state !== 'active' ||
        !inAllowedWindow(row.spec, deps.now()) ||
        Date.parse(row.spec.expiresAt) <= deps.now().getTime()
      )
        throw new ScheduleDenied('SCHEDULE_INACTIVE');
      return fire(deps, row, event.timestamp, event);
    },
  };
}
async function tickSchedule(deps: SchedulerDeps, row: ScheduleRecord): Promise<void> {
  const now = deps.now();
  const stop = await stopReason(deps, row, now);
  if (stop !== undefined) {
    if (row.state === 'active') await revoke(deps, row, stop);
    await cancelRuns(deps, row, stop);
    return;
  }
  await settleRuns(deps, row);
  const runs = await deps.store.runs(row.spec.id);
  for (const run of runs.filter(
    (v) => v.status === 'dispatching' && Date.parse(v.leaseUntil) <= now.getTime(),
  )) {
    const event = run.eventKey === null ? null : await eventForRun(deps, run);
    await fire(deps, row, run.fireAt, event);
  }
  // Trigger-backed schedules are event-only. Their timing is retained for the common spec contract.
  const triggers = await deps.store.triggers(row.spec.sponsor.sub);
  if (triggers.some((v) => v.scheduleId === row.spec.id)) return;
  const slot = dueSlot(row.spec, row.cursor, now);
  if (slot !== undefined) await fire(deps, row, slot, null);
  await deps.store.advance(row.spec.id, now.toISOString());
}
async function eventForRun(deps: SchedulerDeps, run: ScheduleRun): Promise<ReceivedEvent | null> {
  const triggers = await deps.store.triggers(
    (await deps.store.all()).find((v) => v.spec.id === run.scheduleId)!.spec.sponsor.sub,
  );
  const trigger = triggers.find((v) => v.scheduleId === run.scheduleId);
  if (trigger === undefined) throw new Error('event trigger missing');
  // Recover using the source event ID retained in the run's signed evidence via the store recovery accessor.
  const event = await deps.store.eventForRun(run.id);
  if (event === undefined) throw new Error('event receipt missing');
  return event;
}
async function fire(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  fireAt: string,
  event: ReceivedEvent | null,
): Promise<ScheduleRun | undefined> {
  const now = deps.now();
  const run = await deps.store.claim({
    scheduleId: row.spec.id,
    fireAt,
    owner: deps.owner,
    now: now.toISOString(),
    leaseMs: 30000,
    event,
  });
  if (run === undefined) return undefined;
  try {
    if (!inAllowedWindow(row.spec, now) || !inAllowedWindow(row.spec, new Date(fireAt)))
      throw new ScheduleDenied('OUTSIDE_WINDOW');
    const input = await admit(row, run, now, deps);
    // Untrusted payloads are evidence only. The task request remains exactly the pinned template.
    const current = await deps.store.read(row.spec.sponsor.sub, row.spec.id);
    if (current?.state !== 'active') throw new ScheduleDenied('SCHEDULE_PAUSED');
    await finalAdmission(deps, row, run);
    const report = await deps.engine.run({
      taskId: `${run.id}:${run.fence}`,
      subject: row.spec.sponsor.sub,
      steps: [
        {
          id: 'dispatch',
          async run() {
            return JSON.stringify(await deps.dispatch.accept(input));
          },
        },
      ],
    });
    const receipt = report.receipts.find((v) => v.stepId === 'dispatch');
    if (receipt === undefined) throw new Error('workflow dispatch incomplete');
    const accepted = taskAcceptedSchema.parse(JSON.parse(receipt.body) as unknown);
    const stored = await deps.store.finish(
      run,
      { status: 'accepted', taskId: accepted.taskId, reason: null },
      deps.now().toISOString(),
    );
    await afterDispatch(deps, row, stored);
    return stored;
  } catch (error) {
    if (error instanceof ScheduleDenied || error instanceof InvocationStopped) {
      if (
        (await deps.budget.events()).some((v) => v.operationId === run.id && v.kind === 'charged')
      )
        await deps.budget.release(run.id);
      return deps.store.finish(
        run,
        { status: 'denied', taskId: null, reason: error.code },
        deps.now().toISOString(),
      );
    }
    throw error; // Lease recovery retries uncertain dispatch with the same idempotency key.
  }
}
async function afterDispatch(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  run: ScheduleRun,
): Promise<void> {
  const current = await deps.store.read(row.spec.sponsor.sub, row.spec.id);
  try {
    if (current?.state !== 'active') throw new ScheduleDenied('SCHEDULE_PAUSED');
    assertFireTime(row, deps.now());
    await checkAuthority(row.spec, row.digest, deps.now(), deps);
  } catch (error) {
    if (!(error instanceof ScheduleDenied)) throw error;
    await cancelRun(deps, row, run, error.code);
  }
}
async function revoke(deps: SchedulerDeps, row: ScheduleRecord, reason: string): Promise<void> {
  try {
    await deps.store.change(
      row.spec.sponsor.sub,
      row.spec.id,
      row.revision,
      'revoke',
      deps.now().toISOString(),
      reason,
    );
  } catch (error) {
    if (!(error instanceof ScheduleConflict)) throw error;
  }
}
async function cancelRuns(deps: SchedulerDeps, row: ScheduleRecord, reason: string): Promise<void> {
  for (const run of await deps.store.runs(row.spec.id))
    await cancelPendingRun(deps, row, run, reason);
}
async function cancelRun(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  run: ScheduleRun,
  reason: string,
): Promise<void> {
  if (run.taskId === null) return;
  const status = await deps.taskStatus(row.spec.sponsor.sub, run.taskId);
  if (status !== undefined && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
    await deps.store.finish(
      run,
      {
        status: status === 'CANCELLED' ? 'cancelled' : 'completed',
        taskId: run.taskId,
        reason: status,
      },
      deps.now().toISOString(),
    );
    await deps.budget.release(run.id);
    return;
  }
  await deps.cancel(row.spec.sponsor.sub, run.taskId, `schedule-cancel:${run.id}`);
  await deps.store.finish(
    run,
    { status: 'cancelled', taskId: run.taskId, reason },
    deps.now().toISOString(),
  );
  await deps.budget.release(run.id);
}
async function settleRuns(deps: SchedulerDeps, row: ScheduleRecord): Promise<void> {
  for (const run of await deps.store.runs(row.spec.id)) {
    if (run.status !== 'accepted' || run.taskId === null) continue;
    const status = await deps.taskStatus(row.spec.sponsor.sub, run.taskId);
    if (status !== undefined && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
      await deps.store.finish(
        run,
        {
          status: status === 'CANCELLED' ? 'cancelled' : 'completed',
          taskId: run.taskId,
          reason: status,
        },
        deps.now().toISOString(),
      );
      if (
        (await deps.budget.events()).some((v) => v.operationId === run.id && v.kind === 'charged')
      )
        await deps.budget.release(run.id);
    }
  }
}

async function stopReason(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  now: Date,
): Promise<string | undefined> {
  let stop: string | undefined;
  if (row.state !== 'active')
    stop = row.state === 'paused' ? 'SCHEDULE_PAUSED' : 'SCHEDULE_REVOKED';
  else if (Date.parse(row.spec.expiresAt) <= now.getTime()) stop = 'EXPIRED';
  else {
    try {
      await checkAuthority(row.spec, row.digest, now, deps);
    } catch (error) {
      if (error instanceof ScheduleDenied) stop = error.code;
      else throw error;
    }
  }
  return stop;
}

function assertFireTime(row: ScheduleRecord, now: Date): void {
  if (Date.parse(row.spec.expiresAt) <= now.getTime()) throw new ScheduleDenied('EXPIRED');
  if (!inAllowedWindow(row.spec, now)) throw new ScheduleDenied('OUTSIDE_WINDOW');
}
async function finalAdmission(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  run: ScheduleRun,
): Promise<void> {
  const now = deps.now();
  assertFireTime(row, now);
  const authority = await checkAuthority(row.spec, row.digest, now, deps);
  await deps.suspension.check(
    {
      subject: row.spec.sponsor.sub,
      teams: authority.teams,
      agent: { kind: 'agent', ...row.spec.maxPrivilege.skill },
      skill: { kind: 'skill', ...row.spec.maxPrivilege.skill },
      model: deps.model,
      taskId: run.id,
      traceId: run.id.slice(0, 32),
    },
    'admission',
  );
  assertFireTime(row, deps.now());
}

async function cancelPendingRun(
  deps: SchedulerDeps,
  row: ScheduleRecord,
  run: ScheduleRun,
  reason: string,
): Promise<void> {
  if (run.status === 'accepted') {
    await cancelRun(deps, row, run, reason);
    return;
  }
  if (run.status !== 'dispatching') return;
  // A task may commit before the workflow receipt or schedule completion does.
  // Lookup is read-only: revocation must never create work while recovering it.
  const taskId = await deps.findTask(row.spec.sponsor.sub, `schedule:${run.id}`);
  if (taskId === undefined) return;
  const accepted = await deps.store.finish(
    run,
    { status: 'accepted', taskId, reason: null },
    deps.now().toISOString(),
  );
  await cancelRun(deps, row, accepted, reason);
}
