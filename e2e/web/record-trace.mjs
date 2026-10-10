import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const exitCode = process.argv[2] ?? '1';
const files = existsSync('e2e/test-results')
  ? readdirSync('e2e/test-results', { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
  : [];
const dir = 'e2e/artifacts/harness.trace-recorded';
mkdirSync(dir, { recursive: true });

const trace = copyMatch(files, (name) => name === 'trace.zip', join(dir, 'trace.zip'));
const screenshot = copyMatch(
  files,
  (name) => name.endsWith('.png'),
  join(dir, 'harness-trace-recorded.png'),
);
const video = copyMatch(files, (name) => name === 'video.webm', join(dir, 'video.webm'));
const passed = exitCode === '0' && trace && screenshot && video;

writeFileSync(
  'e2e/artifacts/results.json',
  `${JSON.stringify(
    { tests: [{ id: 'harness.trace-recorded', status: passed ? 'passed' : 'failed' }] },
    null,
    2,
  )}\n`,
);

if (!passed) process.exitCode = 1;

function copyMatch(files, predicate, destination) {
  const match = files.find((file) => predicate(basename(file)));
  if (!match) return false;
  copyFileSync(match, destination);
  return true;
}
