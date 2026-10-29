// Segment API entrypoint: one process per segment, with its own database, key directory,
// member allowlist, source allowlist and model budget. `node apps/api/dist/teamwork/server.js`
import { createServer } from 'node:http';

import { createIapVerifier } from '../auth/iap.js';
import { openDatabase } from '../db.js';
import { readLimited } from '../http.js';

import { readSegmentConfig } from './config.js';
import { createTeamworkRuntime } from './runtime.js';

const config = readSegmentConfig(process.env);
const sql = await openDatabase(config.databaseUrl);
const runtime = await createTeamworkRuntime({
  sql,
  config,
  env: process.env,
  verify: createIapVerifier(config.assertion),
});

const maxBodyBytes = 262_144;

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://segment.internal');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    try {
      const body = await readLimited(request, maxBodyBytes);
      if (body === undefined) {
        response
          .writeHead(413, { 'content-type': 'application/json' })
          .end('{"error":"too_large"}');
        return;
      }
      const reply = await runtime.route({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body,
      });
      response.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(reply.body));
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'teamwork-route',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"internal"}');
    }
  })();
});

server.listen(8080, '0.0.0.0', () => {
  runtime.start();
  console.log(
    JSON.stringify({
      level: 'info',
      component: 'segment-api',
      segment: config.segment,
      identity: config.identity,
      sourceMode: config.sourceMode,
      missing: config.missing,
    }),
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await runtime.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
