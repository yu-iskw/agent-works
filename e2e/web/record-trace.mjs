import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const exitCode = process.argv[2] ?? '1';
const found = [];
if (existsSync('e2e/playwright-report.json')) {
  walk(
    JSON.parse(readFileSync('e2e/playwright-report.json', 'utf8')),
    'harness.trace-recorded',
    found,
  );
}
const dir = 'e2e/artifacts/harness.trace-recorded';
mkdirSync(dir, { recursive: true });

const trace = copyAttachment(found, 'trace', join(dir, 'trace.zip'));
const screenshot = copyAttachment(found, 'screenshot', join(dir, 'harness-trace-recorded.png'));
const video = copyAttachment(found, 'video', join(dir, 'video.webm'));
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

function walk(node, title, found) {
  if (!node || typeof node !== 'object') return;
  if (node.title === title && Array.isArray(node.tests)) {
    for (const test of node.tests) {
      for (const result of test.results ?? []) {
        found.push(...(result.attachments ?? []));
      }
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, title, found);
    }
  }
}

function copyAttachment(attachments, name, destination) {
  const match = attachments.find((item) => item.name === name && item.path);
  if (!match || !existsSync(match.path)) return false;
  copyFileSync(match.path, destination);
  return true;
}
