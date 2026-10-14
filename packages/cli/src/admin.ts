import { readFileSync } from 'node:fs';

export type AdminCliOptions = {
  readonly apiUrl?: string;
  readonly assertion?: string;
  readonly fetch?: typeof fetch;
};
type Output = { write(data: string): void };
type ParsedArgs = { sub: string; apiUrl: string; file: string | undefined; mutation: boolean };
const help =
  'Usage: aw admin list|history --url http://127.0.0.1:8084\n       aw admin suspend|resume|version <command.json> --confirm --url <api>\nAn IAP assertion is read from AW_IAP_ASSERTION. Roles come only from the trusted directory.\n';

export async function runAdmin(
  argv: readonly string[],
  stdout: Output,
  options: AdminCliOptions = {},
): Promise<number> {
  if (argv.at(3) === '--help') {
    stdout.write(help);
    return 0;
  }
  const args = parseArgs(argv, options.apiUrl, stdout);
  if (args === undefined) return 1;
  try {
    const command = args.mutation ? readCommand(args.file, args.sub) : undefined;
    const response = await request(args, command, options);
    if (!response.ok) {
      stdout.write(`Admin request failed (${response.status}).\n`);
      return response.status === 403 ? 3 : 2;
    }
    const payload: unknown = await response.json();
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch {
    stdout.write('Admin request failed. Check the command and service availability.\n');
    return 2;
  }
}
function parseArgs(
  argv: readonly string[],
  defaultUrl: string | undefined,
  stdout: Output,
): ParsedArgs | undefined {
  const args = argv.slice(3);
  const sub = args.at(0);
  if (sub === undefined || !['list', 'history', 'suspend', 'resume', 'version'].includes(sub)) {
    stdout.write(help);
    return undefined;
  }
  const urlFlag = args.indexOf('--url');
  const apiUrl = urlFlag === -1 ? defaultUrl : args.at(urlFlag + 1);
  if (apiUrl === undefined || URL.parse(apiUrl) === null) {
    stdout.write('A valid --url is required.\n');
    return undefined;
  }
  const mutation = ['suspend', 'resume', 'version'].includes(sub);
  if (mutation && !args.includes('--confirm')) {
    stdout.write('Review the command file, then pass --confirm.\n');
    return undefined;
  }
  return { sub, apiUrl, file: args.at(1), mutation };
}
function request(args: ParsedArgs, command: unknown, options: AdminCliOptions): Promise<Response> {
  const path =
    args.sub === 'history'
      ? '/v1/admin/history'
      : args.sub === 'version'
        ? '/v1/admin/versions'
        : '/v1/admin/suspensions';
  return (options.fetch ?? fetch)(new URL(path, args.apiUrl), {
    method: args.mutation ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.assertion === undefined ? {} : { 'x-goog-iap-jwt-assertion': options.assertion }),
    },
    ...(args.mutation ? { body: JSON.stringify(command) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
}
function readCommand(file: string | undefined, sub: string): unknown {
  if (file === undefined || file.startsWith('--')) throw new Error('command file required');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit operator-selected command file
  const command: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (command === null || typeof command !== 'object' || Array.isArray(command))
    throw new Error('invalid command');
  if (sub !== 'version' && (!('action' in command) || command.action !== sub))
    throw new Error('command action mismatch');
  return command;
}
