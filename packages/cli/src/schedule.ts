import { readFileSync } from 'node:fs';
export type ScheduleCliOptions = { apiUrl?: string; assertion?: string; fetch?: typeof fetch };
type Output = { write(data: string): void };
const usage =
  'Usage: aw schedule list|history|triggers --url <api>\n       aw schedule create|preview|trigger|pause|resume|revoke|runs <command.json> --url <api>\n';
const changePath = '/v1/schedules/change';
const paths = new Map([
  ['list', '/v1/schedules'],
  ['history', '/v1/schedules/history'],
  ['triggers', '/v1/schedules/triggers'],
  ['create', '/v1/schedules'],
  ['preview', '/v1/schedules/preview'],
  ['trigger', '/v1/schedules/triggers'],
  ['pause', changePath],
  ['resume', changePath],
  ['revoke', changePath],
  ['runs', '/v1/schedules/runs'],
]);
export async function runSchedule(
  argv: readonly string[],
  stdout: Output,
  options: ScheduleCliOptions = {},
): Promise<number> {
  const args = argv.slice(3);
  const sub = args.at(0);
  if (sub === '--help') {
    stdout.write(usage);
    return 0;
  }
  const path = sub === undefined ? undefined : paths.get(sub);
  if (path === undefined) {
    stdout.write(usage);
    return 1;
  }
  const url = commandUrl(args, options.apiUrl);
  if (url === undefined) {
    stdout.write('A valid --url is required.\n');
    return 1;
  }
  return executeSchedule(args, sub!, path, url, { stdout, options });
}
async function executeSchedule(
  args: readonly string[],
  sub: string,
  path: string,
  url: string,
  io: { stdout: Output; options: ScheduleCliOptions },
): Promise<number> {
  const { stdout, options } = io;
  const mutation = !['list', 'history', 'triggers'].includes(sub);
  try {
    const body = mutation ? readScheduleCommand(args.at(1), sub) : undefined;
    const response = await (options.fetch ?? fetch)(new URL(path, url), {
      method: mutation ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.assertion === undefined
          ? {}
          : { 'x-goog-iap-jwt-assertion': options.assertion }),
      },
      ...(mutation ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      stdout.write(`Schedule request failed (${response.status}).\n`);
      return response.status === 403 ? 3 : 2;
    }
    const payload: unknown = await response.json();
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch {
    stdout.write('Schedule request failed. Check the command and service availability.\n');
    return 2;
  }
}
function readScheduleCommand(file: string | undefined, sub: string): unknown {
  if (file === undefined || file.startsWith('--')) throw new Error('command file required');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit operator command file
  const body: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new Error('invalid command');
  if (['pause', 'resume', 'revoke'].includes(sub) && (!('action' in body) || body.action !== sub))
    throw new Error('command action mismatch');
  return body;
}

function commandUrl(args: readonly string[], fallback: string | undefined): string | undefined {
  const flag = args.indexOf('--url');
  const value = flag === -1 ? fallback : args.at(flag + 1);
  if (value === undefined) return undefined;
  const url = URL.parse(value);
  return url !== null && ['http:', 'https:'].includes(url.protocol) ? value : undefined;
}
