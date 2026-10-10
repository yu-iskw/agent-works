import { appendResult } from '../results.mjs';
import { writePng } from '../png.mjs';

const id = 'schemas.up-to-date';
const passed =
  process.argv[2] === '0' &&
  (process.argv[3] ?? '').split('\n').some((line) => line.trim() === '6 schemas up to date');

writePng(`e2e/artifacts/${id}/${id.replaceAll('.', '-')}.png`, passed ? 'passed' : 'failed');
appendResult({ id, status: passed ? 'passed' : 'failed' });

if (!passed) process.exitCode = 1;
