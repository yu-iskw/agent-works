import { readFileSync } from 'node:fs';

import { validateEvidence } from './evidence.mjs';

export function readPrincipalProof(
  bytes = readFileSync(new URL('./fixtures/valid.json', import.meta.url)),
) {
  const checked = validateEvidence(bytes);
  if (!checked.ok || checked.assessment.verdict !== 'unverified')
    throw new Error('Principal evidence rejected');
  const { request, response } = checked;
  if (
    request.caller !== request.owner ||
    request.agent !== request['bound-agent'] ||
    request['user-context'] !== 'active' ||
    request.scope !== 'read' ||
    request['static-key'] ||
    response.outcome !== 'allowed' ||
    !response['unique-principal'] ||
    !response['least-privilege'] ||
    response['implicit-user-authority'] ||
    response['static-key-used']
  )
    throw new Error('Principal separation not demonstrated');
  return Object.freeze({
    schemaVersion: 1,
    principal: request.agent,
    caller: request.caller,
    scope: request.scope,
    uniquePrincipal: true,
    userAuthoritySeparate: true,
    staticKey: false,
    provenance: checked.transcript.provenance.kind,
    digest: JSON.parse(bytes.toString()).digest,
    liveValidation: 'UNVERIFIED',
    verdict: 'DEFER',
  });
}
