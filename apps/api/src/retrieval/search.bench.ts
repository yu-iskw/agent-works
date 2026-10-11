import { pathToFileURL } from 'node:url';

import { createDrive, listen } from '@agent-works/fakes';

import { startFakeCallers } from './fake-caller.js';
import { createHttpDrive } from './http-drive.js';

const budgetMs = 50;
const samples = 300;
const warmup = 20;

function percentile(sorted: readonly number[], rank: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted.at(index) ?? 0;
}

async function measure(): Promise<{ p50: number; p95: number; max: number }> {
  const directory = await listen((request) => {
    const sub = request.url.pathname.split('/').pop() ?? '';
    return {
      status: 200,
      body: {
        sub,
        groups: ['agent-users@company.example'],
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    };
  }, 0);
  const drive = await listen(createDrive(directory.url), 0);
  const callers = await startFakeCallers();
  try {
    const alice = await callers.as('alice');
    const http = createHttpDrive({ baseUrl: drive.url, directoryUrl: directory.url });
    const durations: number[] = [];
    for (let sample = 0; sample < warmup + samples; sample += 1) {
      const started = performance.now();
      const scope = await http.open(alice);
      const hits = await scope.port.search(scope.context, 'triage');
      const elapsed = performance.now() - started;
      if (hits.length !== 1) throw new Error('bench search lost the triage runbook');
      if (sample >= warmup) durations.push(elapsed);
    }
    durations.sort((left, right) => left - right);
    return {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.at(-1) ?? 0,
    };
  } finally {
    await callers.close();
    await drive.close();
    await directory.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await measure();
  process.stdout.write(
    `search p50 ${result.p50.toFixed(2)} ms p95 ${result.p95.toFixed(2)} ms max ${result.max.toFixed(2)} ms\n`,
  );
  if (result.p95 > budgetMs) process.exitCode = 1;
}
