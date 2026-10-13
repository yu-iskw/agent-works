// #106: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'identity-gateway';
export const requestShape = {
  component: ['registry', 'gateway'],
  registered: 'boolean',
  'publication-approved': 'boolean',
  'user-context': ['active', 'absent', 'revoked'],
  tool: ['read', 'denied-tool'],
  path: ['gateway', 'direct'],
  'principal-proof': 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied'],
  'publication-enforced': 'boolean',
  'egress-enforced': 'boolean',
};

export function expectedResponse(request) {
  const publication = request.registered && request['publication-approved'];
  const allowed =
    request.component === 'registry'
      ? publication && request['principal-proof']
      : publication &&
        request['principal-proof'] &&
        request['user-context'] === 'active' &&
        request.tool === 'read' &&
        request.path === 'gateway';
  return {
    outcome: allowed ? 'allowed' : 'denied',
    'publication-enforced': true,
    'egress-enforced': true,
  };
}
