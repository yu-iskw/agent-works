// #111: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'sandbox';
export const requestShape = {
  network: ['blocked', 'exfiltration'],
  'ambient-creds': 'boolean',
  filesystem: ['scratch', 'restricted'],
  'elapsed-ms': 'integer',
  'memory-mib': 'integer',
  'cpu-ms': 'integer',
  'storage-mib': 'integer',
  isolation: 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied', 'terminated'],
  'network-blocked': 'boolean',
  'credentials-absent': 'boolean',
  'filesystem-restricted': 'boolean',
  isolated: 'boolean',
  'limits-enforced': 'boolean',
};

export function expectedResponse(request) {
  const unsafe =
    request.network === 'exfiltration' ||
    request['ambient-creds'] ||
    request.filesystem === 'restricted' ||
    !request.isolation;
  const exceeded =
    request['elapsed-ms'] > 100 ||
    request['memory-mib'] > 64 ||
    request['cpu-ms'] > 50 ||
    request['storage-mib'] > 8;
  return {
    outcome: unsafe ? 'denied' : exceeded ? 'terminated' : 'allowed',
    'network-blocked': true,
    'credentials-absent': true,
    'filesystem-restricted': true,
    isolated: true,
    'limits-enforced': true,
  };
}
