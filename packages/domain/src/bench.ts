import { pathToFileURL } from 'node:url';

import {
  canonicalPayloadJson,
  canonicalPayloadSha256,
  sha256DigestSchema,
} from './canonical-hash.js';

const PAYLOAD_BYTES = 10 * 1024;
const FIXED_WRAPPER_BYTES = 10;

export function tenKilobytePayload(): { pad: string } {
  return { pad: 'a'.repeat(PAYLOAD_BYTES - FIXED_WRAPPER_BYTES) };
}

export function meanCanonicalHashMs(iterations: number): number {
  const payload = tenKilobytePayload();
  if (canonicalPayloadJson(payload).length !== PAYLOAD_BYTES) {
    throw new Error('bench payload is not 10 KB');
  }
  for (let warmup = 0; warmup < 10; warmup += 1) {
    canonicalPayloadSha256(payload);
  }
  const started = performance.now();
  let digest = '';
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    digest = canonicalPayloadSha256(payload);
  }
  const mean = (performance.now() - started) / iterations;
  if (!sha256DigestSchema.safeParse(digest).success) {
    throw new Error('bench digest missing');
  }
  return mean;
}

function isDirectRun(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const mean = meanCanonicalHashMs(50);
  process.stdout.write(`canonicalPayloadSha256 mean ${mean.toFixed(4)} ms\n`);
  if (mean > 2) {
    process.exitCode = 1;
  }
}
