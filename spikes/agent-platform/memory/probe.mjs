// #107: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'memory';
export const requestShape = {
  caller: ['user-a', 'user-b'],
  owner: ['user-a', 'user-b'],
  agent: ['agent-a', 'agent-b'],
  'memory-agent': ['agent-a', 'agent-b'],
  'user-context': ['active', 'absent', 'revoked'],
  operation: ['read', 'delete'],
  deleted: 'boolean',
  'retention-expired': 'boolean',
  'deletion-supported': 'boolean',
  'retention-evidence': 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied', 'deleted', 'unavailable'],
  'memory-visible': 'boolean',
  'deletion-confirmed': 'boolean',
  'retention-demonstrated': 'boolean',
};

export function expectedResponse(request) {
  const authorized =
    request.caller === request.owner &&
    request.agent === request['memory-agent'] &&
    request['user-context'] === 'active';
  let outcome = 'denied';
  if (authorized && request.operation === 'delete')
    outcome = request['deletion-supported'] ? 'deleted' : 'unavailable';
  else if (authorized && !request.deleted && !request['retention-expired']) outcome = 'allowed';
  return {
    outcome,
    'memory-visible': outcome === 'allowed',
    'deletion-confirmed': outcome === 'deleted' || request.deleted,
    'retention-demonstrated': request['retention-evidence'],
  };
}
