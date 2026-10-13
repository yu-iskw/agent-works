// #112: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'agent-identity';
export const requestShape = {
  caller: ['user-a', 'user-b'],
  owner: ['user-a', 'user-b'],
  agent: ['agent-a', 'agent-b'],
  'bound-agent': ['agent-a', 'agent-b'],
  'user-context': ['active', 'absent', 'revoked'],
  scope: ['read', 'admin'],
  'static-key': 'boolean',
  'direct-source': 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied'],
  'unique-principal': 'boolean',
  'least-privilege': 'boolean',
  'implicit-user-authority': 'boolean',
  'static-key-used': 'boolean',
};

export function expectedResponse(request) {
  const denied =
    request.caller !== request.owner ||
    request.agent !== request['bound-agent'] ||
    request['user-context'] !== 'active' ||
    request.scope !== 'read' ||
    request['static-key'];
  return {
    outcome: denied ? 'denied' : 'allowed',
    'unique-principal': request.agent === request['bound-agent'],
    'least-privilege': request.scope === 'read',
    'implicit-user-authority': false,
    'static-key-used': false,
  };
}
