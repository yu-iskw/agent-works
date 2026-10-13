import { runProbe, validateEvidence } from './evidence.mjs';
import { gatewayPrincipal } from './principal-proof.mjs';

export async function runGateway(caseId, request, backend, principalBytes) {
  // Invalid proof throws before the backend can receive a request. A valid
  // synthetic proof demonstrates fixture binding only, never live authority.
  const proof = gatewayPrincipal(principalBytes);
  if (!backend || typeof backend.exchange !== 'function')
    throw new Error('Missing offline adapter');
  const boundBackend = {
    async exchange(label, fields) {
      // The proof travels as explicit adapter context, separate from per-user authority.
      return backend.exchange(label, fields, proof);
    },
  };
  const envelope = await runProbe(caseId, request, boundBackend);
  const result = validateEvidence(JSON.stringify(envelope));
  return { proof, evidence: envelope, result };
}
