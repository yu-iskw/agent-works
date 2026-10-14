import { describe, expect, it } from 'vitest';

import { connectorApiUrl } from './connectors-url.js';
describe('connector CLI offline endpoint', () => {
  it.each(['http://127.0.0.1:8084', 'http://localhost:8084', 'http://[::1]:8084'])(
    'accepts loopback endpoint %s',
    (url) => {
      expect(connectorApiUrl(url).pathname).toBe('/v1/oauth/connections');
    },
  );
  it.each([
    'https://localhost',
    'http://example.test',
    'http://alice:secret@127.0.0.1',
    'file:///tmp/file',
    'http://127.0.0.1.attacker.test',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => connectorApiUrl(url)).toThrow('offline endpoint');
  });
});
