// Read-only dependency on #112. Gateway owns neither the principal fixture nor its code.
import { readPrincipalProof } from '../agent-identity/principal-proof.mjs';

export function gatewayPrincipal(bytes) {
  const proof = readPrincipalProof(bytes);
  return Object.freeze({
    principal: proof.principal,
    caller: proof.caller,
    scope: proof.scope,
    authoritySeparated: proof.userAuthoritySeparate,
    evidenceDigest: proof.digest,
    provenance: proof.provenance,
    liveValidation: proof.liveValidation,
    verdict: proof.verdict,
  });
}

export function componentVerdicts(results) {
  const verdictFor = (component) => {
    const selected = results.filter((result) => result.request.component === component);
    if (!selected.length) return 'DEFER';
    return selected.some((result) => result.assessment.verdict === 'no-go') ? 'NO-GO' : 'DEFER';
  };
  return {
    registry: verdictFor('registry'),
    gateway: verdictFor('gateway'),
    liveValidation: 'UNVERIFIED',
  };
}
