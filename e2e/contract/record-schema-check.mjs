import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const passed =
  process.argv[2] === '0' &&
  (process.argv[3] ?? '').split('\n').some((line) => line.trim() === '6 schemas up to date');

mkdirSync('e2e/artifacts/schemas.up-to-date', { recursive: true });
writeFileSync(
  'e2e/artifacts/schemas.up-to-date/schemas-up-to-date.png',
  png(passed ? [16, 140, 64] : [180, 32, 32]),
);
writeFileSync(
  'e2e/artifacts/results.json',
  `${JSON.stringify({ tests: [{ id: 'schemas.up-to-date', status: passed ? 'passed' : 'failed' }] }, null, 2)}\n`,
);

if (!passed) {
  process.exitCode = 1;
}

function png(rgb) {
  const width = 64;
  const height = 16;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, name, data, checksum]);
}
