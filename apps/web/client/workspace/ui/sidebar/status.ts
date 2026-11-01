// Status words for task rows. Text first, colour second: the tone drives the indicator colour,
// the label is what a screen reader and a colour-blind member get.

import type { TeamworkStatus } from '@agent-works/domain/teamwork';

type StatusTone = 'working' | 'attention' | 'done' | 'failed' | 'quiet';

type StatusView = { readonly label: string; readonly tone: StatusTone };

const STATUS: Readonly<Record<TeamworkStatus, StatusView>> = {
  planning: { label: 'Planning', tone: 'working' },
  plan_review: { label: 'Plan review', tone: 'attention' },
  running: { label: 'Running', tone: 'working' },
  needs_input: { label: 'Needs input', tone: 'attention' },
  synthesizing: { label: 'Synthesizing', tone: 'working' },
  ready: { label: 'Result ready', tone: 'done' },
  awaiting_action_approval: { label: 'Approval needed', tone: 'attention' },
  publishing: { label: 'Publishing', tone: 'working' },
  completed: { label: 'Completed', tone: 'done' },
  outcome_uncertain: { label: 'Outcome uncertain', tone: 'attention' },
  failed: { label: 'Failed', tone: 'failed' },
  declined: { label: 'Declined', tone: 'quiet' },
  cancel_requested: { label: 'Cancelling', tone: 'quiet' },
  cancelled: { label: 'Cancelled', tone: 'quiet' },
};

export function statusView(status: TeamworkStatus): StatusView {
  // `status` is the closed TeamworkStatus enum.
  // eslint-disable-next-line security/detect-object-injection
  return STATUS[status];
}
