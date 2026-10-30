// M1 web BFF. Port 8080 is the member-facing app (published on loopback by Compose). Port 8081
// serves only the assertion JWKS and the gated e2e session endpoint, and is never published.
import { createServer } from 'node:http';

import { createSegmentClient } from '../app/m1/api.js';
import { readWebConfig } from '../app/m1/config.js';
import { openWebDb } from '../app/m1/db.js';
import { createM1Handler } from '../app/m1/handler.js';
import { createAssertionSigner, createGoogleVerifier, createIdentity } from '../app/m1/identity.js';
import { createInternalHandler } from '../app/m1/internal.js';

const config = readWebConfig(process.env);
const db = await openWebDb(config.databaseUrl, config.keyDir);
const signer = createAssertionSigner(config.identity);
const identity = createIdentity({
  config,
  db,
  verifyGoogle:
    config.google === undefined ? undefined : createGoogleVerifier(config.google.clientId),
});
const handler = createM1Handler({ config, identity, api: createSegmentClient(config, signer) });

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  handler(request, response);
}).listen(8080, '0.0.0.0');

createServer(createInternalHandler({ config, identity, signer })).listen(8081, '0.0.0.0');

console.log(
  JSON.stringify({
    level: 'info',
    component: 'm1-web',
    identity: config.identity,
    segments: config.segments.map((s) => s.id),
    missing: config.missing,
    e2e: config.e2eSecret !== undefined,
  }),
);
