import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const requestPath = 'artifacts/m1/bot-control-request.json';
const resultPath = 'artifacts/m1/bot-control-result.json';
const compose = [
  'compose',
  '-f',
  'compose.m1.yaml',
  '-f',
  'scripts/m1/compose-bots.yaml',
  '-p',
  'aw-m1-bots',
  '--profile',
  'bots',
];

while (true) {
  if (!existsSync(requestPath)) {
    await setTimeout(100);
    continue;
  }
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  unlinkSync(requestPath);
  try {
    if (request.operation === 'restart') {
      for (const command of ['kill', 'start']) {
        const result = spawnSync('docker', [...compose, command, 'api-alpha'], {
          encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(`docker ${command} failed: ${result.stderr}`);
      }
    } else if (request.operation !== 'count') {
      throw new Error('unknown operation');
    }
    const script =
      "fetch('http://127.0.0.1:9097/test/submit-count?key='+encodeURIComponent(process.argv[1])).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))";
    const result = spawnSync(
      'docker',
      [...compose, 'exec', '-T', 'reference-alpha', 'node', '-e', script, request.key],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`submit count failed: ${result.stderr}`);
    writeFileSync(
      resultPath,
      JSON.stringify({ operation: request.operation, ...JSON.parse(result.stdout) }),
    );
  } catch (error) {
    writeFileSync(
      resultPath,
      JSON.stringify({ operation: request.operation, error: String(error) }),
    );
  }
}
