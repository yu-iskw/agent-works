import { validateEvidence } from './evidence.mjs';

export function verifyRecovery(envelopes) {
  const defer = (reason) => ({ verdict: 'DEFER', reason, liveValidation: 'UNVERIFIED' });
  if (!Array.isArray(envelopes) || envelopes.length !== 3) return defer('missing-recovery');
  const records = envelopes.map((envelope) => validateEvidence(JSON.stringify(envelope)));
  if (records.some((record) => !record.ok)) return defer('invalid-evidence');
  const [start, abort, restart] = records;
  const ownership = ['caller', 'owner', 'agent', 'session-agent'];
  if (
    !ownership.every((key) => records.every((record) => record.request[key] === start.request[key]))
  )
    return {
      verdict: 'NO-GO',
      reason: 'recovery-owner-substitution',
      liveValidation: 'UNVERIFIED',
    };
  if (records.some((record) => record.assessment.verdict === 'no-go'))
    return { verdict: 'NO-GO', reason: 'recovery-control-failure', liveValidation: 'UNVERIFIED' };
  if (
    start.request.operation !== 'read' ||
    abort.request.operation !== 'abort' ||
    restart.request.operation !== 'restart'
  )
    return defer('recovery-order');
  if (
    start.response.outcome !== 'allowed' ||
    abort.response.outcome !== 'aborted' ||
    restart.response.outcome !== 'recovered' ||
    !restart.request.checkpoint
  )
    return defer('recovery-not-demonstrated');
  return defer('synthetic-recovery-only');
}
