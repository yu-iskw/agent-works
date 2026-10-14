import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

type Options = { apiUrl?: string; assertion?: string; fetch?: typeof fetch };
type Output = { write(value: string): void };
const usage =
  'Usage: aw analytics metrics|reports --url API\n       aw analytics query|save|rerun COMMAND.json --url API [--confirm]\n';
const commands = new Map([
  ['metrics', { path: '/v1/analytics/metrics', method: 'GET' }],
  ['reports', { path: '/v1/analytics/reports', method: 'GET' }],
  ['query', { path: '/v1/analytics/query', method: 'POST' }],
  ['save', { path: '/v1/analytics/reports', method: 'POST' }],
  ['rerun', { path: '/v1/analytics/reports/rerun', method: 'POST' }],
]);
export async function runAnalytics(
  args: readonly string[],
  stdout: Output,
  options: Options = {},
): Promise<number> {
  if (args[0] === '--help') {
    stdout.write(usage);
    return 0;
  }
  const command = commands.get(args[0]);
  if (command === undefined) {
    stdout.write(usage);
    return 1;
  }
  if (args[0] === 'save' && !args.includes('--confirm')) {
    stdout.write('Review the query, then pass --confirm to save a validated version.\n');
    return 1;
  }
  try {
    const urlAt = args.indexOf('--url');
    const url = urlAt === -1 ? options.apiUrl : args.at(urlAt + 1);
    if (url === undefined) throw new Error('URL required');
    const endpoint = new URL(command.path, url);
    checkEndpoint(endpoint);
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: command.method,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        ...(options.assertion === undefined
          ? {}
          : { 'x-goog-iap-jwt-assertion': options.assertion }),
      },
      ...(command.method === 'GET' ? {} : { body: JSON.stringify(readCommand(args.at(1))) }),
    });
    if (!response.ok) {
      stdout.write(`Analytics request failed (${response.status}).\n`);
      return response.status === 403 ? 3 : 2;
    }
    const payload: unknown = await response.json();
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch {
    stdout.write('Analytics request failed. Check the command and service availability.\n');
    return 2;
  }
}
function readCommand(path: string | undefined): unknown {
  if (path === undefined || path.startsWith('--')) throw new Error('command file required');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit operator-selected JSON command
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > 16384) throw new Error('command too large');
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid command');
  return value;
}
function checkEndpoint(endpoint: URL): void {
  const host = endpoint.hostname;
  const local =
    host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
  if (
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:'))
  )
    throw new Error('invalid URL');
}
