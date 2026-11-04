type BotTrigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; ref: string; scheduledFor: string }
  | { kind: 'event'; ref: string; source: string; eventType: string; payload: unknown };
type StartBotRunInput = {
  teammateId: string;
  trigger: BotTrigger;
  initiatedBy: string;
  clientRequestId: string;
  expectedRevision?: number;
};
type StartBotRunResult =
  | { kind: 'started'; taskId: string; revision: number; digest: string }
  | { kind: 'duplicate'; taskId: string }
  | { kind: 'denied'; code: string }
  | {
      kind: 'deferred';
      code: 'bot_cap' | 'member_cap' | 'segment_cap' | 'cost_budget';
      retryAfterMs?: number;
    };
export type StartBotRun = (input: StartBotRunInput) => Promise<StartBotRunResult>;
