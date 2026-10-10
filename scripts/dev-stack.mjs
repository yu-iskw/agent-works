import { spawnSync } from 'node:child_process';

const compose = ['compose', '-f', 'compose.dev.yml'];
const waited = ['up', '-d', '--wait', '--wait-timeout', '100'];

function run(args) {
  const result = spawnSync('docker', [...compose, ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

function report() {
  const result = spawnSync('docker', [...compose, 'ps', '--format', '{{.Service}} {{.Health}}'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  const healthy = lines.filter((line) => line.endsWith(' healthy')).length;
  const summary = `${healthy}/${lines.length} services healthy`;
  process.stdout.write(`${summary}\n`);
  if (summary !== '6/6 services healthy') process.exit(1);
}

const command = process.argv[2];
if (command === 'up' && process.argv.includes('--wait')) {
  run(waited);
  report();
} else if (command === 'up') run(['up', '-d']);
else if (command === 'down') run(['down', '--remove-orphans']);
else if (command === 'reset') {
  run(['down', '-v', '--remove-orphans']);
  run(waited);
  report();
} else process.exit(1);
