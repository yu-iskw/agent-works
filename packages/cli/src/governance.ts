import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

type GovernanceCliOptions = {
  readonly apiUrl?: string;
  readonly assertion?: string;
  readonly fetch?: typeof fetch;
};
type Output = { write(value: string): void };
const usage =
  'Usage: aw governance holds|deletions --url http://127.0.0.1:8084\n       aw governance hold|delete|process COMMAND.json --confirm --url API\n';
const commands = new Map([
  ['holds', { path: '/v1/admin/governance/holds', mutation: false }],
  ['deletions', { path: '/v1/admin/governance/deletions', mutation: false }],
  ['hold', { path: '/v1/admin/governance/holds', mutation: true }],
  ['delete', { path: '/v1/admin/governance/deletions', mutation: true }],
  ['process', { path: '/v1/admin/governance/deletions/process', mutation: true }],
]);
function readCommand(file: string | undefined): unknown {
  if (file === undefined || file.startsWith('--')) throw new Error('command file required');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-selected command file
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid command');
  return value;
}
export async function runGovernance(
  args: readonly string[],
  stdout: Output,
  options: GovernanceCliOptions = {},
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
  if (command.mutation && !args.includes('--confirm')) {
    stdout.write('Review the command file, then pass --confirm.\n');
    return 1;
  }
  const urlIndex = args.indexOf('--url');
  const url = urlIndex === -1 ? options.apiUrl : args.at(urlIndex + 1);
  if (url === undefined) {
    stdout.write('A valid --url is required.\n');
    return 1;
  }
  try {
    const response = await sendGovernanceRequest(command, args, url, options);
    if (!response.ok) {
      stdout.write(`Governance request failed (${response.status}).\n`);
      return response.status === 403 ? 3 : 2;
    }
    const payload: unknown = await response.json();
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch {
    stdout.write('Governance request failed. Check the command and service availability.\n');
    return 2;
  }
}

async function sendGovernanceRequest(
  command: { path: string; mutation: boolean },
  args: readonly string[],
  url: string,
  options: GovernanceCliOptions,
): Promise<Response> {
  const endpoint = new URL(command.path, url);
  if (
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && isLoopback(endpoint.hostname))) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  )
    throw new Error('invalid URL');
  return (options.fetch ?? fetch)(endpoint, {
    method: command.mutation ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.assertion === undefined ? {} : { 'x-goog-iap-jwt-assertion': options.assertion }),
    },
    ...(command.mutation ? { body: JSON.stringify(readCommand(args.at(1))) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}
