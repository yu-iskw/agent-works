import { pathToFileURL } from 'node:url';

import { startReferenceAgent } from './reference-http.js';

export { startReferenceAgent } from './reference-http.js';

async function main() {
  const args = process.argv.slice(2);
  const port = args.length === 2 && args[0] === '--port' ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Usage: reference-agent-server.js --port <0..65535>');
  const server = await startReferenceAgent({ port });
  process.stdout.write(`${JSON.stringify({ reference: true, endpoint: server.endpoint })}\n`);
  const stop = () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write('Reference agent startup failed; use --port <0..65535>\n');
    process.exitCode = 1;
  });
