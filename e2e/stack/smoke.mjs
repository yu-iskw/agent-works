import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const green =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAAN0lEQVR4nO3PUQkAAAjE0ItgJAMa2hB+DGGwAG+p6dcFFzhACxygBQ7QAgdogQO0wAFa4AAtOLYDFHAun/eMCwAAAABJRU5ErkJggg==';
const red =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAAN0lEQVR4nO3PQQkAAAzDwEqp//cETsQeYRCIgEumfV1wgQO0wAFa4AAtcIAWOEALHKAFDtCCYws1LtAu3NMgpwAAAABJRU5ErkJggg==';

const code = process.argv[2] ?? '';
const output = readFileSync(process.argv[3] ?? '', 'utf8');
const reportedHealthy = output.split('\n').some((line) => line.trim() === '6/6 services healthy');
const stackPassed = code === '0' && reportedHealthy && (await everyHealthz());
const scriptPassed = await unknownScript();

write('stack.all-healthy', 'stack-all-healthy.png', stackPassed);
write('fakes.unknown-llm-script', 'fakes-unknown-llm-script.png', scriptPassed);
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

function write(id, file, passed) {
  mkdirSync(`e2e/artifacts/${id}`, { recursive: true });
  writeFileSync(`e2e/artifacts/${id}/${file}`, Buffer.from(passed ? green : red, 'base64'));
}

async function everyHealthz() {
  try {
    for (const port of [8081, 8082, 8083, 8084, 8085]) {
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
