import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DlqInvocation = {
  readonly action: 'list' | 'requeue' | 'compensate';
  readonly file: string;
};
export function parseDlqArgs(args: readonly string[]): DlqInvocation {
  if (args.length !== 3 || args[1] !== '--fixture')
    throw new Error('usage: aw dlq list|requeue|compensate --fixture FILE');
  const action = args[0];
  if (action !== 'list' && action !== 'requeue' && action !== 'compensate')
    throw new Error('unknown dlq action');
  return { action, file: args[2] };
}
export function runDlq(args: readonly string[], stdout: { write(body: string): void }): number {
  try {
    const input = parseDlqArgs(args);
    const driver = fileURLToPath(new URL('../../../tools/restore-drill/dlq.mjs', import.meta.url));
    stdout.write(
      execFileSync(process.execPath, [driver, input.action, input.file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return 0;
  } catch {
    stdout.write('DLQ command failed; use a disposable fixture and explicit review evidence.\n');
    return 1;
  }
}
