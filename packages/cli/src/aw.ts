#!/usr/bin/env node
import { run } from './run.js';

const code = await main();
if (code !== 0) process.exitCode = code;

async function main(): Promise<number> {
  // Issue 140 subcommand registration.
  if (process.argv[2] === 'schedule') {
    return (await import('./schedule.js')).runSchedule(process.argv, process.stdout, {
      assertion: process.env.AW_IAP_ASSERTION,
    });
  }
  // Issue 135 subcommand registration. Other command blocks remain independent.
  if (process.argv[2] === 'dlq') {
    return (await import('./dlq.js')).runDlq(process.argv.slice(3), process.stdout);
  }
  if (process.argv[2] === 'finops') {
    return (await import('./finops.js')).runFinops(process.argv.slice(3), process.stdout);
  }
  // Issue 134 admin subcommand.
  if (process.argv[2] === 'admin') {
    return await run(
      [process.argv[0], process.argv[1], 'admin', ...process.argv.slice(3)],
      process.stdout,
    );
  }
  return run(process.argv, process.stdout);
}
