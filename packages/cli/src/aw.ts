#!/usr/bin/env node
import { run } from './run.js';

// Issue 135 subcommand registration. Other command blocks remain independent.
if (process.argv[2] === 'dlq' || process.argv[2] === 'finops') {
  const code =
    process.argv[2] === 'dlq'
      ? (await import('./dlq.js')).runDlq(process.argv.slice(3), process.stdout)
      : (await import('./finops.js')).runFinops(process.argv.slice(3), process.stdout);
  if (code !== 0) process.exitCode = code;
} else {
  const code = run(process.argv, process.stdout);
  if (code !== 0) process.exitCode = code;
}
