import { validateEvidence } from './evidence.mjs';

export function verifyDeletionLifecycle(envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length !== 3)
    return { verdict: 'DEFER', reason: 'missing-lifecycle', liveValidation: 'UNVERIFIED' };
  const records = envelopes.map((envelope) => validateEvidence(JSON.stringify(envelope)));
  if (records.some((record) => !record.ok))
    return { verdict: 'DEFER', reason: 'invalid-evidence', liveValidation: 'UNVERIFIED' };
  const [before, deletion, after] = records;
  // A demonstrated control failure is NO-GO even when lifecycle binding is incomplete.
  if (records.some((record) => record.assessment.verdict === 'no-go'))
    return { verdict: 'NO-GO', reason: 'deletion-control-failure', liveValidation: 'UNVERIFIED' };
  const ownership = ['caller', 'owner', 'agent', 'memory-agent'];
  const sameOwner = ownership.every((key) =>
    records.every((record) => record.request[key] === before.request[key]),
  );
  if (
    !sameOwner ||
    before.request.operation !== 'read' ||
    deletion.request.operation !== 'delete' ||
    after.request.operation !== 'read' ||
    !after.request.deleted
  )
    return { verdict: 'DEFER', reason: 'lifecycle-binding', liveValidation: 'UNVERIFIED' };
  const failed = after.response['memory-visible'];
  const demonstrated =
    before.response['memory-visible'] &&
    deletion.response['deletion-confirmed'] &&
    !after.response['memory-visible'] &&
    records.every((record) => record.response['retention-demonstrated']);
  return {
    verdict: failed ? 'NO-GO' : 'DEFER',
    reason: failed
      ? 'deletion-control-failure'
      : demonstrated
        ? 'synthetic-lifecycle-only'
        : 'incomplete-deletion-retention',
    liveValidation: 'UNVERIFIED',
  };
}
