import { readFileSync, writeFileSync } from 'node:fs';

import { writePng } from '../png.mjs';

const code = process.argv[2] ?? '';
const output = readFileSync(process.argv[3] ?? '', 'utf8');
const reportedHealthy = output.split('\n').some((line) => line.trim() === '7/7 services healthy');
const stackPassed = code === '0' && reportedHealthy && (await everyHealthz());
const scriptPassed = await unknownScript();

writePng(
  'e2e/artifacts/stack.all-healthy/stack-all-healthy.png',
  stackPassed ? 'passed' : 'failed',
);
writePng(
  'e2e/artifacts/fakes.unknown-llm-script/fakes-unknown-llm-script.png',
  scriptPassed ? 'passed' : 'failed',
);
writeFileSync(
  'e2e/artifacts/results.json',
  `${JSON.stringify(
    {
      tests: [
        { id: 'stack.all-healthy', status: stackPassed ? 'passed' : 'failed' },
        { id: 'fakes.unknown-llm-script', status: scriptPassed ? 'passed' : 'failed' },
      ],
    },
    null,
    2,
  )}\n`,
);

if (!stackPassed || !scriptPassed) process.exitCode = 1;

async function everyHealthz() {
  try {
    for (const port of [8081, 8082, 8083, 8084, 8085, 8086]) {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status !== 200 || (await response.text()).trim() !== 'ok') return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function unknownScript() {
  try {
    const response = await fetch('http://127.0.0.1:8083/v1beta/models/gemini:generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [] }),
    });
    return response.status === 599;
  } catch {
    return false;
  }
}
