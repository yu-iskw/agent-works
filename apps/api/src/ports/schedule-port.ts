import type {
  EventTrigger,
  ReceivedEvent,
  ScheduleAudit,
  ScheduleRun,
  ScheduleRecord,
  ScheduleSpec,
} from '@agent-works/domain';
export class ScheduleConflict extends Error {
  constructor(message = 'schedule conflict') {
    super(message);
    this.name = 'ScheduleConflict';
  }
}
export type ScheduleState = {
  schedules: ScheduleRecord[];
  triggers: EventTrigger[];
  runs: ScheduleRun[];
  events: ReceivedEvent[];
  audit: ScheduleAudit[];
};
export interface ScheduleDriver {
  transaction<T>(operation: (state: ScheduleState) => T): Promise<T>;
}
export type ClaimRun = {
  scheduleId: string;
  fireAt: string;
  owner: string;
  now: string;
  leaseMs: number;
  event: ReceivedEvent | null;
};
export type RunCompletion = {
  status: Exclude<ScheduleRun['status'], 'dispatching'>;
  taskId: string | null;
  reason: string | null;
};
export interface SchedulePort {
  create(
    spec: ScheduleSpec,
    actorSub: string,
    at: string,
    trigger?: EventTrigger,
  ): Promise<ScheduleRecord>;
  list(subject: string): Promise<readonly ScheduleRecord[]>;
  all(): Promise<readonly ScheduleRecord[]>;
  read(subject: string, id: string): Promise<ScheduleRecord | undefined>;
  change(
    subject: string,
    id: string,
    revision: number,
    action: 'pause' | 'resume' | 'revoke',
    at: string,
    reason?: string,
  ): Promise<ScheduleRecord>;
  advance(id: string, cursor: string): Promise<void>;
  claim(input: ClaimRun): Promise<ScheduleRun | undefined>;
  finish(run: ScheduleRun, result: RunCompletion, at: string): Promise<ScheduleRun>;
  runs(id: string): Promise<readonly ScheduleRun[]>;
  history(subject: string): Promise<readonly ScheduleAudit[]>;
  triggers(subject: string): Promise<readonly EventTrigger[]>;
  trigger(id: string): Promise<EventTrigger | undefined>;
  eventForRun(runId: string): Promise<ReceivedEvent | undefined>;
  received(source: string, eventId: string): Promise<ReceivedEvent | undefined>;
}
