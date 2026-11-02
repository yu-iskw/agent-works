// The coordinator recap, derived from persisted inbox and task state. No model call: it is a
// grounded summary of what needs the member, what is running, and what recently finished.

import type { RecapView } from '../../shared/contract.js';
import type { InboxItem, ResultEntry, TaskSummary } from '@agent-works/domain/teamwork';

const DECISION_KINDS = new Set<InboxItem['kind']>([
  'question',
  'plan_review',
  'approval',
  'failed',
  'uncertain',
]);

export const RECAP_ROWS = 5;

/**
 * `inbox` is the open page (newest first), `running` the running-status page, `results` the
 * newest artifact revisions. Each section is capped so the recap stays a glance, and the counts
 * say how much lies beyond the cap.
 */
export function buildRecap(
  segment: string,
  input: {
    readonly inbox: readonly InboxItem[];
    readonly running: readonly TaskSummary[];
    readonly results: readonly ResultEntry[];
  },
): RecapView {
  const decisions = input.inbox.filter(
    (item) => item.state === 'open' && DECISION_KINDS.has(item.kind),
  );
  const running = input.running.filter((task) => task.status !== 'completed');
  const seen = new Set<string>();
  const results = input.results.filter((row) =>
    seen.has(row.taskId) ? false : (seen.add(row.taskId), true),
  );
  return {
    segment,
    decisions: decisions.slice(0, RECAP_ROWS),
    running: running.slice(0, RECAP_ROWS),
    results: results.slice(0, RECAP_ROWS),
    counts: { decisions: decisions.length, running: running.length },
  };
}
