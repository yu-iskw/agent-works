// #108: offline policy expectations, not vendor behavior or an SDK implementation.
export const feature = 'model';
export const requestShape = {
  region: ['asia-northeast1', 'disallowed-region'],
  model: ['synthetic-model-v1', 'disallowed-model'],
  endpoint: ['regional', 'global'],
  'endpoint-healthy': 'boolean',
  'user-context': ['active', 'absent', 'revoked'],
  prompt: ['[redacted]'],
  'prompt-redacted': 'boolean',
  'read-only': 'boolean',
};
export const responseShape = {
  outcome: ['allowed', 'denied', 'unavailable'],
  'policy-bypassed': 'boolean',
  'prompt-retained': 'boolean',
  'regional-processing': 'boolean',
};

export function expectedResponse(request) {
  const allowed =
    request.region === 'asia-northeast1' &&
    request.model === 'synthetic-model-v1' &&
    request.endpoint === 'regional' &&
    request['user-context'] === 'active' &&
    request['prompt-redacted'] &&
    request['read-only'];
  return {
    outcome: !allowed ? 'denied' : request['endpoint-healthy'] ? 'allowed' : 'unavailable',
    'policy-bypassed': false,
    'prompt-retained': false,
    'regional-processing': true,
  };
}
