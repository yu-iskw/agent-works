import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runFinops(args: readonly string[], stdout: { write(body: string): void }): number {
  if (args.length !== 3 || args[0] !== 'report' || args[1] !== '--fixture') {
    stdout.write('usage: aw finops report --fixture FILE\n');
    return 1;
  }
  try {
    const driver = fileURLToPath(new URL('../../../tools/finops/report.mjs', import.meta.url));
    stdout.write(
      execFileSync(process.execPath, [driver, args[2]], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return 0;
  } catch {
    stdout.write('FinOps fixture report failed.\n');
    return 1;
  }
}
