import { readFileSync } from 'node:fs';
export type MemoryCliOptions = { apiUrl?: string; assertion?: string; fetch?: typeof fetch };
type Output = { write: (value: string) => void };
const usage =
  'Usage: aw memory list|export|consent --url <api>\n       aw memory opt-in|opt-out|edit|delete <command.json> --url <api>\n';
const consentPath = '/v1/memory/consent';
const commands = new Map([
  ['list', ['GET', '/v1/memory']],
  ['export', ['GET', '/v1/memory/export']],
  ['consent', ['GET', consentPath]],
  ['opt-in', ['POST', consentPath]],
  ['opt-out', ['POST', consentPath]],
  ['edit', ['POST', '/v1/memory/edit']],
  ['delete', ['POST', '/v1/memory/delete']],
]);
export async function runMemory(
  args: readonly string[],
  output: Output,
  options: MemoryCliOptions = {},
): Promise<number> {
  const sub = args.at(0);
  if (sub === '--help') {
    output.write(usage);
    return 0;
  }
  const command = sub === undefined ? undefined : commands.get(sub);
  if (command === undefined) {
    output.write(usage);
    return 1;
  }
  const url = memoryUrl(args, options.apiUrl);
  if (url === null) {
    output.write('A valid --url is required.\n');
    return 1;
  }
  return executeMemory(args, sub!, command, url, { output, options });
}
function memoryUrl(args: readonly string[], fallback: string | undefined): URL | null {
  const flag = args.indexOf('--url');
  const value = flag < 0 ? fallback : args.at(flag + 1);
  const url = value === undefined ? null : URL.parse(value);
  return url !== null &&
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url
    : null;
}
async function executeMemory(
  args: readonly string[],
  sub: string,
  command: string[],
  url: URL,
  io: { output: Output; options: MemoryCliOptions },
): Promise<number> {
  const { output, options } = io;
  try {
    const [method, path] = command;
    const body = method === 'POST' ? readCommand(args.at(1), sub) : undefined;
    const response = await (options.fetch ?? fetch)(new URL(path, url), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.assertion === undefined
          ? {}
          : { 'x-goog-iap-jwt-assertion': options.assertion }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      output.write(`Memory request failed (${response.status}).\n`);
      return response.status === 403 ? 3 : 2;
    }
    output.write(`${JSON.stringify((await response.json()) as unknown, null, 2)}\n`);
    return 0;
  } catch {
    output.write('Memory request failed. Check the command and service availability.\n');
    return 2;
  }
}
function readCommand(file: string | undefined, sub: string): unknown {
  if (file === undefined || file.startsWith('--')) throw new Error('command file required');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-selected reviewed command
  const body: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new Error('invalid command');
  if (
    (sub === 'opt-in' || sub === 'opt-out') &&
    (!('enabled' in body) || body.enabled !== (sub === 'opt-in'))
  )
    throw new Error('consent mismatch');
  return body;
}
