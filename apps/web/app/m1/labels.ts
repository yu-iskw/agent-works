import type {
  AssignmentStatus,
  Capability,
  InboxKind,
  SourceKind,
  StatementKind,
  TeamworkStatus,
  Workflow,
} from '@agent-works/domain/teamwork';

type Tone = 'active' | 'wait' | 'ok' | 'bad' | 'neutral';

/** One row per task status: what the member sees and what they can do next. */
export const TASK_STATUS: Record<
  TeamworkStatus,
  { readonly label: string; readonly tone: Tone; readonly explain: string }
> = {
  planning: {
    label: 'Planning',
    tone: 'active',
    explain: 'The coordinator is drafting a plan. Nothing is dispatched until you approve it.',
  },
  plan_review: {
    label: 'Plan review',
    tone: 'wait',
    explain: 'Review who will do what, with which sources, before any work starts.',
  },
  running: {
    label: 'Running',
    tone: 'active',
    explain:
      'Specialists are working in parallel. You can leave; results and questions arrive in your inbox.',
  },
  needs_input: {
    label: 'Needs input',
    tone: 'wait',
    explain:
      'A specialist asked a question or a contribution did not finish. Decide how to continue.',
  },
  synthesizing: {
    label: 'Writing result',
    tone: 'active',
    explain: 'The result owner is combining the contributions.',
  },
  ready: {
    label: 'Ready for review',
    tone: 'ok',
    explain: 'Review the result, check its sources, ask for a revision, or prepare publication.',
  },
  awaiting_action_approval: {
    label: 'Awaiting approval',
    tone: 'wait',
    explain:
      'A publication is waiting for your exact approval. Nothing is written until you approve.',
  },
  publishing: { label: 'Publishing', tone: 'active', explain: 'Creating the approved document.' },
  completed: {
    label: 'Completed',
    tone: 'ok',
    explain: 'Done. You can still ask for a new revision.',
  },
  outcome_uncertain: {
    label: 'Outcome uncertain',
    tone: 'bad',
    explain:
      'The provider did not confirm the write. Check for the document before retrying; it will not be created twice.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    explain: 'A step stopped. The reason and the recovery are below.',
  },
  declined: {
    label: 'Plan rejected',
    tone: 'neutral',
    explain: 'You rejected the plan. Nothing was dispatched.',
  },
  cancel_requested: {
    label: 'Cancelling',
    tone: 'active',
    explain: 'Stopping at the next safe step. Nothing new will start.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    explain: 'Cancelled. Completed contributions are kept; nothing was published.',
  },
};

export const ASSIGNMENT_STATUS: Record<
  AssignmentStatus,
  { readonly label: string; readonly tone: Tone }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Working', tone: 'active' },
  needs_input: { label: 'Has a question', tone: 'wait' },
  succeeded: { label: 'Contributed', tone: 'ok' },
  failed: { label: 'Did not finish', tone: 'bad' },
  timed_out: { label: 'Timed out', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export const WORKFLOW: Record<
  Workflow,
  { readonly label: string; readonly short: string; readonly explain: string }
> = {
  research_brief: {
    label: 'Research to decision brief',
    short: 'Research',
    explain:
      'Specialists read the segment research folder in Google Drive and the coordinator writes an evidence-backed decision brief you can publish to Google Docs.',
  },
  metrics_explanation: {
    label: 'Business metrics to explanation',
    short: 'Metrics',
    explain:
      'A data specialist runs approved BigQuery reads, a researcher checks business context in Drive, and the coordinator explains the change with exact numbers.',
  },
  engineering_proposal: {
    label: 'Engineering request to implementation proposal',
    short: 'Engineering',
    explain:
      'Specialists read the GitHub issue and code at a pinned commit, and the coordinator writes an implementation proposal. Nothing in GitHub is changed.',
  },
};

const SOURCE: Record<SourceKind, string> = {
  drive_research: 'Drive research folder',
  drive_context: 'Drive business context folder',
  bigquery_metrics: 'BigQuery metrics (read-only)',
  github_issue: 'GitHub issue',
  github_code: 'GitHub code at pinned commit',
};

export const CAPABILITY: Record<Capability, string> = {
  'drive.read': 'Read Drive',
  'docs.publish': 'Create Google Docs (with approval)',
  'bigquery.query': 'Query BigQuery (read-only)',
  'github.read': 'Read GitHub',
};

export const STATEMENT: Record<StatementKind, string> = {
  fact: 'Fact',
  calculation: 'Calculation',
  assumption: 'Assumption',
  hypothesis: 'Hypothesis',
  question: 'Open question',
  recommendation: 'Recommendation',
  proposed_action: 'Proposed action',
};

export const INBOX: Record<
  InboxKind,
  { readonly label: string; readonly group: 'decide' | 'problems' | 'results' }
> = {
  question: { label: 'Needs you', group: 'decide' },
  plan_review: { label: 'Plan to review', group: 'decide' },
  approval: { label: 'Approval', group: 'decide' },
  failed: { label: 'Failed', group: 'problems' },
  uncertain: { label: 'Uncertain write', group: 'problems' },
  completed: { label: 'Result', group: 'results' },
};

export function sourceLabel(kind: SourceKind): string {
  // eslint-disable-next-line security/detect-object-injection
  return SOURCE[kind];
}

export function capabilityLabel(capability: Capability): string {
  // eslint-disable-next-line security/detect-object-injection
  return CAPABILITY[capability];
}

export function workflowInfo(workflow: Workflow): (typeof WORKFLOW)[Workflow] {
  // eslint-disable-next-line security/detect-object-injection
  return WORKFLOW[workflow];
}

/** Stable error codes from the API, in member-facing words. */
const ERRORS: Record<string, string> = {
  stale_plan: 'The plan changed since you loaded it. Review the current version and decide again.',
  plan_not_current: 'That plan version is no longer the one under review.',
  not_in_plan_review: 'This task is no longer waiting for plan review.',
  stale_digest:
    'The publication changed since you loaded it. Review the current content and decide again.',
  stale_revision:
    'A newer revision exists, so that approval was voided. Nothing was published. Prepare publication again for the current revision.',
  approval_expired:
    'The approval expired. Nothing was published. Prepare it again to review the current content.',
  already_decided: 'That was already decided. The recorded decision stands.',
  not_awaiting_approval: 'This task is not waiting for an approval.',
  capability_denied:
    'Publishing is not available: your membership, the result owner, or your Google connection in this segment does not allow it.',
  invalid_request: 'Some fields were missing or invalid. Your input is kept below.',
  client_request_reused:
    'That form was already submitted with different content. Your input is kept below.',
  no_synthesis_skill:
    'The result owner needs a synthesis skill for this workflow. Attach one on the teammate page, or choose another owner.',
  teammate_not_found: 'One of the chosen teammates is not available.',
  source_not_allowed: 'One of the chosen sources is not used by this workflow.',
  source_unavailable_for_teammate:
    'A chosen specialist cannot use one of its ticked sources (see the Capabilities on its page). Untick that source or pick another specialist. Your input is kept below.',
  assignments_required: 'Add at least one assignment, or let the coordinator plan the work.',
  metrics_scope_required: 'Choose the baseline and current months for the comparison.',
  metrics_periods_equal: 'The baseline and current months must differ.',
  issue_required: 'This segment has no GitHub issue configured. Enter an issue number.',
  stale_version:
    'Someone (or another tab) changed this teammate. Reload to see the latest version.',
  reply_pending: 'Wait for the teammate to answer your previous message.',
  not_dismissable: 'Only results can be dismissed. Decisions are resolved on the task.',
  segment_unreachable:
    'This segment backend is unreachable. Your input is kept; try again shortly.',
  segment_not_found: 'You do not have access to that segment.',
  not_member: 'Your account is not a member of this segment.',
  unauthenticated: 'Your session ended. Sign in again.',
  bad_contract:
    'The segment backend returned an unexpected response. Reload to see the current state.',
  csrf: 'Your session token did not match. Reload the page and try again.',
  contains_secrets:
    'The definition contains something that looks like a credential, so it was not imported.',
  invalid_definition: 'That is not a valid teammate definition file.',
  provider_not_configured:
    'This provider is not configured for the segment. See docs/m1/SETUP_OAUTH.md.',
  oauth_state_invalid: 'That connection attempt expired or was already used. Start it again.',
  connection_account_mismatch:
    'Connect the same Google account you signed in with. Other accounts cannot be used.',
  oauth_exchange_failed: 'The provider did not complete the connection. Try again.',
  nothing_to_retry: 'There is nothing to retry.',
  nothing_to_synthesize:
    'No contribution succeeded, so there is nothing to combine. Retry instead.',
  nothing_to_reconcile: 'There is no uncertain write to check.',
  rescope_not_supported: 'Only metrics tasks can change their comparison.',
  no_data_assignment: 'This task has no finished data assignment to re-run.',
  not_waiting_for_answer: 'That specialist is no longer waiting for an answer.',
  result_owner_changed: 'The result owner of a plan cannot change.',
  duplicate_assignment_key: 'Two assignments have the same name.',
  bad_dependency: 'An assignment depends on one that does not exist.',
  cannot_replan: 'A new plan can only be requested while reviewing a plan.',
};

export function errorText(code: string): string {
  // eslint-disable-next-line security/detect-object-injection
  if (Object.hasOwn(ERRORS, code)) return ERRORS[code] ?? code;
  const blocked = /^cannot_([a-z]+)_([a-z_]+)$/.exec(code);
  if (blocked !== null)
    return `This task cannot ${blocked[1]} while it is ${blocked[2].replaceAll('_', ' ')}. The page shows its current state.`;
  return 'That request could not be completed. The page shows the current state.';
}

export function when(iso: string | null): string {
  if (iso === null) return '';
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
