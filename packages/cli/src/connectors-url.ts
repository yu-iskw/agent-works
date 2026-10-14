const offlineEndpoint = 'offline endpoint';
export function connectorApiUrl(input: string): URL {
  const base = new URL(input);
  if (base.protocol !== 'http:') throw new Error(offlineEndpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new Error(offlineEndpoint);
  if (base.username || base.password) throw new Error(offlineEndpoint);
  return new URL('/v1/oauth/connections', base);
}
