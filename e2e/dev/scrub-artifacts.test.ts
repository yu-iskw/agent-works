/* eslint-disable security/detect-non-literal-fs-filename -- unit test operates on isolated mkdtempSync directories */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createZipBuffer,
  readZipBuffer,
  scrubArtifactsDirectory,
  scrubText,
  verifyArtifactsClean,
} from './scrub-artifacts.mjs';

const sampleJwtA =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWEiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUudGVzdCJ9.c2lnbmF0dXJlLWEtMTIzNDU2Nzg5MA';
const sampleJwtB =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWIiLCJlbWFpbCI6ImJvYkBleGFtcGxlLnRlc3QifQ.c2lnbmF0dXJlLWItMTIzNDU2Nzg5MA';
const opaqueSecretA = 'opaque-iap-secret-token-alpha-987654321';
const opaqueSecretB = 'opaque-iap-secret-token-bravo-123456789';

describe('scrub-artifacts', () => {
  it('redacts JWT strings, Authorization headers, x-goog-iap-jwt-assertion headers, and exact env secrets in text', () => {
    const raw = JSON.stringify(
      {
        headers: {
          Authorization: `Bearer ${opaqueSecretA}`,
          'x-goog-iap-jwt-assertion': sampleJwtB,
        },
        rawHttp: [
          `authorization: Bearer ${sampleJwtA}`,
          `X-Goog-Iap-Jwt-Assertion: ${opaqueSecretB}`,
        ],
        leakedTokenA: opaqueSecretA,
        leakedTokenB: opaqueSecretB,
        inlineJwt: `token=${sampleJwtA}`,
      },
      null,
      2,
    );

    const scrubbed = scrubText(raw, [opaqueSecretA, opaqueSecretB]);
    expect(scrubbed).not.toContain(opaqueSecretA);
    expect(scrubbed).not.toContain(opaqueSecretB);
    expect(scrubbed).not.toContain(sampleJwtA);
    expect(scrubbed).not.toContain(sampleJwtB);
    expect(scrubbed).toContain('[REDACTED]');
    expect(scrubbed).toContain('[REDACTED_TOKEN]');
    expect(scrubbed).toContain('[REDACTED_JWT]');
  });

  it('scrubs regular files and trace.zip entries in place and passes post-scrub verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-scrub-test-'));
    try {
      const traceDir = join(dir, 'skeleton.sign-in-ask-cite-audit');
      mkdirSync(traceDir, { recursive: true });

      const resultsPath = join(dir, 'results.json');
      writeFileSync(
        resultsPath,
        JSON.stringify({
          authorization: `Bearer ${opaqueSecretA}`,
          'x-goog-iap-jwt-assertion': sampleJwtA,
          note: `userB=${opaqueSecretB}`,
        }),
      );

      const traceZipPath = join(traceDir, 'trace.zip');
      const zipBuffer = createZipBuffer([
        {
          name: '0-trace.network',
          method: 8,
          data: Buffer.from(
            JSON.stringify({
              requestHeaders: [
                { name: 'Authorization', value: `Bearer ${sampleJwtA}` },
                { name: 'x-goog-iap-jwt-assertion', value: sampleJwtB },
              ],
              rawAuth: `Authorization: Bearer ${opaqueSecretA}\r\nx-goog-iap-jwt-assertion: ${opaqueSecretB}`,
            }),
            'utf8',
          ),
        },
        {
          name: 'trace.trace',
          method: 0,
          data: Buffer.from(`tokenA=${opaqueSecretA} jwt=${sampleJwtB}`, 'utf8'),
        },
      ]);
      writeFileSync(traceZipPath, zipBuffer);

      const summary = scrubArtifactsDirectory(dir, {
        env: {
          AW_DEV_ID_TOKEN_A: opaqueSecretA,
          AW_DEV_ID_TOKEN_B: opaqueSecretB,
        },
      });
      expect(summary.filesScanned).toBe(2);
      expect(summary.zipArchivesScrubbed).toBe(1);

      const scrubbedResults = readFileSync(resultsPath, 'utf8');
      for (const secret of [opaqueSecretA, opaqueSecretB, sampleJwtA, sampleJwtB]) {
        expect(scrubbedResults).not.toContain(secret);
      }

      const entries = readZipBuffer(readFileSync(traceZipPath));
      expect(entries.map((entry) => entry.name)).toEqual(['0-trace.network', 'trace.trace']);
      for (const entry of entries) {
        const text = entry.data.toString('utf8');
        for (const secret of [opaqueSecretA, opaqueSecretB, sampleJwtA, sampleJwtB]) {
          expect(text).not.toContain(secret);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed and exits non-zero when an exact secret remains in a file or inside trace.zip without echoing the secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-scrub-leak-'));
    try {
      const traceZipPath = join(dir, 'trace.zip');
      // Invalid UTF-8 prefix (0xff, 0xfe) + UTF-16LE secret cannot be decoded as UTF-8 text,
      // so the post-scrub binary/UTF-16 detector must catch the remaining secret inside trace.zip.
      const binaryLeak = Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x80]),
        Buffer.from(opaqueSecretA, 'utf16le'),
      ]);
      writeFileSync(
        traceZipPath,
        createZipBuffer([{ name: 'binary-leak.bin', method: 8, data: binaryLeak }]),
      );

      expect(() =>
        scrubArtifactsDirectory(dir, {
          env: {
            AW_DEV_ID_TOKEN_A: opaqueSecretA,
            AW_DEV_ID_TOKEN_B: opaqueSecretB,
          },
        }),
      ).toThrow(/secret|token|redaction/i);

      expect(() => verifyArtifactsClean(dir, [opaqueSecretA])).toThrow(/secret|token/i);

      const scriptPath = resolve(import.meta.dirname, 'scrub-artifacts.mjs');
      const run = spawnSync(process.execPath, [scriptPath, dir], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AW_DEV_ID_TOKEN_A: opaqueSecretA,
          AW_DEV_ID_TOKEN_B: opaqueSecretB,
        },
      });
      expect(run.status).not.toBe(0);
      expect(run.stdout).not.toContain(opaqueSecretA);
      expect(run.stderr).not.toContain(opaqueSecretA);
      expect(run.stdout).not.toContain(opaqueSecretB);
      expect(run.stderr).not.toContain(opaqueSecretB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
