import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const green = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAAN0lEQVR4nO3PUQkAAAjE0ItgJAMa2hB+DGGwAG+p6dcFFzhACxygBQ7QAgdogQO0wAFa4AAtOLYDFHAun/eMCwAAAABJRU5ErkJggg==',
  'base64',
);
const red = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAAN0lEQVR4nO3PQQkAAAzDwEqp//cETsQeYRCIgEumfV1wgQO0wAFa4AAtcIAWOEALHKAFDtCCYws1LtAu3NMgpwAAAABJRU5ErkJggg==',
  'base64',
);
const pending = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAAN0lEQVR4nO3PUQkAAAjE0ItidDOZyBB+DGGwAG+ZrtcFFzhACxygBQ7QAgdogQO0wAFa4AAtOLZMmUhbtrPcywAAAABJRU5ErkJggg==',
  'base64',
);

const tones = { passed: green, failed: red, pending };

export function writePng(file, tone) {
  const bytes = tones[tone];
  if (!bytes) throw new Error(`unknown png tone ${tone}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
