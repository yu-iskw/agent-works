// #105: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'runtime';
export const requestShape = {
  caller: ['user-a', 'user-b'],
  owner: ['user-a', 'user-b'],
  agent: ['agent-a', 'agent-b'],
  'session-agent': ['agent-a', 'agent-b'],
  'user-context': ['active', 'revoked', 'absent'],
  operation: ['read', 'abort', 'restart'],
  'region-available': 'boolean',
  'sdk-compatible': 'boolean',
  'quota-available': 'boolean',
  checkpoint: 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied', 'aborted', 'recovered', 'unavailable'],
  'session-isolated': 'boolean',
  bounded: 'boolean',
  recovered: 'boolean',
};

export function expectedResponse(request) {
  const isolated =
    request.caller === request.owner &&
    request.agent === request['session-agent'] &&
    request['user-context'] === 'active';
  let outcome = 'allowed';
  if (!isolated) outcome = 'denied';
  else if (
    !request['region-available'] ||
    !request['sdk-compatible'] ||
    !request['quota-available']
  )
    outcome = 'unavailable';
  else if (request.operation === 'abort') outcome = 'aborted';
  else if (request.operation === 'restart') outcome = request.checkpoint ? 'recovered' : 'denied';
  return { outcome, 'session-isolated': true, bounded: true, recovered: outcome === 'recovered' };
}
