// Member-facing text for the error codes a send, upload or task start can return. Every message
// says what to do next; the draft and its chips are always kept, so none says "lost".

import { ApiFailure } from '../api.js';

const TEXT: Partial<Readonly<Record<string, string>>> = {
  reply_pending: "Wait for the teammate's reply before sending again.",
  budget_exhausted: "This segment's model budget is used up for now. Try again later.",
  not_configured: 'The model is not configured in this segment, so nothing can be sent yet.',
  model_unavailable: 'The model did not answer. Try again in a moment.',
  attachment_too_large: 'That file is over 200 KB. Trim it or split it.',
  attachment_media_type: 'That file type is not supported; use .txt, .md, .csv or .json.',
  attachment_not_text: 'That file is not UTF-8 text.',
  attachment_empty: 'That file has no text.',
  attachment_invalid_json: 'That file is not valid JSON.',
  attachment_invalid_csv: 'That file is not well-formed CSV.',
  attachment_removed: 'One of the files was removed. Attach it again.',
  attachment_not_found: 'One of the files is no longer available. Remove it and attach it again.',
  attachment_in_use: 'That file was already sent with a message, so it stays as provenance.',
  source_unavailable_for_teammate:
    'A specialist cannot use one of its ticked sources here. Untick it or pick another specialist.',
  source_not_allowed: 'One of the ticked sources is not used by this workflow.',
  no_synthesis_skill:
    'The result owner needs a synthesis skill for this workflow. Choose another owner.',
  teammate_not_found: 'One of the chosen teammates is not available any more.',
  assignments_required: 'Add at least one specialist, or ask the coordinator for a plan.',
  metrics_scope_required: 'Choose the baseline and current months.',
  metrics_periods_equal: 'The baseline and current months must differ.',
  repository_required: 'Choose a repository.',
  repository_not_allowed: 'This segment does not allow that repository.',
  issue_required: 'Enter the GitHub issue number.',
  client_request_reused:
    'This draft was already started with different content. Discard it and start again.',
  not_waiting_for_answer: 'That question was already answered.',
  conversation_not_found: 'This conversation is no longer available. Reload the page.',
  csrf: 'Your session token did not match. Reload the page and try again.',
  unauthenticated: 'Your session ended. Sign in again.',
  segment_unreachable: 'The segment did not answer. Try again shortly.',
  segment_auth_failed: 'The segment refused the request. Wait a few seconds and reload.',
  bad_contract: 'The segment returned an unexpected response. Reload to see the current state.',
  too_large: 'That request is too large.',
  bad_request: 'Some fields were missing or invalid.',
};

const PREFIXES: readonly { readonly prefix: string; readonly text: string }[] = [
  {
    prefix: 'cannot_revise_',
    text: 'This result cannot be revised while the task is in that state.',
  },
  { prefix: 'cannot_decide_', text: 'The task is not waiting for that decision.' },
];

export function errorText(error: unknown, kept: string): string {
  const code = error instanceof ApiFailure ? error.code : 'unavailable';
  // Codes come from the BFF's closed error vocabulary, looked up in a fixed table.
  // eslint-disable-next-line security/detect-object-injection
  const known = TEXT[code] ?? PREFIXES.find((p) => code.startsWith(p.prefix))?.text;
  const base = known ?? `Could not complete that (${code}).`;
  return `${base} ${kept}`;
}

export const KEPT_MESSAGE = 'Your message and its context are kept.';
export const KEPT_DRAFT = 'The task draft is kept.';
