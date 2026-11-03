import { describe, expect, it, vi } from 'vitest';

import { createFakeSandbox } from './fake-sandbox.js';
import { createCapabilityGuard, CapabilityDisabledError, sealGateRecord } from './gate.js';
import { createGuardedSandbox, releasableArtifacts } from './sandbox-contract.js';
import {
  assessSandboxEvidence,
  MATRIX_CASES,
  runNegativeMatrix,
  sealSandboxEvidence,
} from './sandbox-matrix.js';

import type { FakeFlaw } from './fake-sandbox.js';
import type { ExecutionRequest } from './sandbox-contract.js';

const now = new Date('2026-11-03T00:00:00Z');
const target = { project: 'proj-a', scope: 'team-x', digest: 'b'.repeat(64) };
const request: ExecutionRequest = {
  executionId: 'e1',
  program: { language: 'python', source: 'print(1)' },
  probe: 'none',
  limits: { cpuMs: 1, memoryBytes: 1, wallMs: 1, outputBytes: 1 },
  network: 'none',
};

describe('negative-test matrix on the fake sandbox', () => {
  it('holds every case for a correct fake and labels the result offline', async () => {
    const report = await runNegativeMatrix(createFakeSandbox());
    expect(report.evidenceKind).toBe('offline-fake');
    expect(report.cases.map((item) => item.id)).toEqual([...MATRIX_CASES]);
    expect(report.allHeld).toBe(true);
  });

  const flawToCase: readonly [FakeFlaw, string][] = [
    ['metadata-fetch', 'metadata-exfiltration'],
    ['credential-read', 'credential-exfiltration'],
    ['egress-connect', 'unexpected-egress'],
    ['host-file-read', 'filesystem-escape'],
    ['memory-bomb', 'resource-exhaustion'],
    ['cpu-spin', 'resource-exhaustion'],
    ['wall-hang', 'resource-exhaustion'],
    ['leak-after-run', 'cleanup'],
  ];
  it.each(flawToCase)('flags a sandbox with flaw %s as breached in %s', async (flaw, caseId) => {
    const report = await runNegativeMatrix(createFakeSandbox([flaw]));
    expect(report.allHeld).toBe(false);
    expect(report.cases.find((item) => item.id === caseId)?.outcome).toBe('breached');
  });

  it('treats an adapter that throws as a breach, not a pass', async () => {
    const report = await runNegativeMatrix({
      run: () => Promise.reject(new Error('boom')),
      residue: () => Promise.resolve(0),
    });
    expect(report.allHeld).toBe(false);
  });

  it('releases only scanned-clean artifacts', async () => {
    const result = await createFakeSandbox().run({ ...request, probe: 'emit-artifact' });
    expect(result.artifacts).toHaveLength(1);
    expect(releasableArtifacts(result)).toEqual([]);
    const clean = { ...result, artifacts: [{ ...result.artifacts[0], scan: 'clean' as const }] };
    expect(releasableArtifacts(clean)).toHaveLength(1);
  });
});

describe('sealed live evidence ingestion', () => {
  const live = {
    probe: 'sandbox' as const,
    issue: 111 as const,
    source: 'operator-live' as const,
    capturedAt: '2026-11-04T00:00:00Z',
    region: 'asia-northeast1',
    product: 'example-sandbox',
    launchStage: 'preview',
    cases: Object.fromEntries(MATRIX_CASES.map((id) => [id, 'held' as const])),
  };

  it('is UNTESTED and DEFER when evidence is absent, never PASS', () => {
    for (const absent of [undefined, null]) {
      expect(assessSandboxEvidence(absent)).toMatchObject({ status: 'UNTESTED', verdict: 'DEFER' });
    }
  });

  it('ignores an offline report: a passing fake does not move the gate', async () => {
    const report = await runNegativeMatrix(createFakeSandbox());
    expect(assessSandboxEvidence(report)).toMatchObject({ status: 'UNTESTED', verdict: 'DEFER' });
  });

  it('rejects tampered, incomplete and wrong-region evidence as UNTESTED', () => {
    const sealed = sealSandboxEvidence(live) as Record<string, unknown>;
    expect(assessSandboxEvidence({ ...sealed, product: 'other' }).reason).toMatch(/digest/);
    const partial = sealSandboxEvidence({ ...live, cases: { cleanup: 'held' } });
    expect(assessSandboxEvidence(partial)).toMatchObject({ status: 'UNTESTED' });
    const elsewhere = sealSandboxEvidence({ ...live, region: 'us-central1' });
    expect(assessSandboxEvidence(elsewhere)).toMatchObject({ status: 'UNTESTED' });
  });

  it('reports FAIL and NO-GO when any live control was breached', () => {
    const breached = sealSandboxEvidence({
      ...live,
      cases: { ...live.cases, 'unexpected-egress': 'breached' },
    });
    expect(assessSandboxEvidence(breached)).toMatchObject({ status: 'FAIL', verdict: 'NO-GO' });
  });

  it('reaches PASS only as GO-ELIGIBLE from complete sealed operator evidence', () => {
    expect(assessSandboxEvidence(sealSandboxEvidence(live))).toMatchObject({
      status: 'PASS',
      verdict: 'GO-ELIGIBLE',
    });
  });
});

describe('guarded sandbox', () => {
  it('denies by default without touching the sandbox or any worker fallback', async () => {
    const sandbox = { run: vi.fn(), residue: vi.fn() };
    const workerExecutor = vi.fn();
    const guarded = createGuardedSandbox({
      guard: createCapabilityGuard(),
      context: target,
      sandbox,
      now: () => now,
    });
    await expect(guarded.run(request)).rejects.toBeInstanceOf(CapabilityDisabledError);
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(workerExecutor).not.toHaveBeenCalled();
  });

  it('runs when a matching GO record exists and surfaces sandbox failures without fallback', async () => {
    const record = sealGateRecord({
      ...target,
      capability: 'sandboxExecution',
      verdict: 'GO',
      signedOffBy: 'operator@example.test',
      approvalRef: 'GATE-1',
      signedOffAt: '2026-11-02T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    const guard = createCapabilityGuard([record]);
    const ok = createGuardedSandbox({
      guard,
      context: target,
      sandbox: createFakeSandbox(),
      now: () => now,
    });
    await expect(ok.run(request)).resolves.toMatchObject({ status: 'ok' });
    const failing = createGuardedSandbox({
      guard,
      context: target,
      sandbox: { run: () => Promise.reject(new Error('down')), residue: () => Promise.resolve(0) },
      now: () => now,
    });
    await expect(failing.run(request)).rejects.toThrow('down');
  });

  it('denies a record bound to another digest', async () => {
    const record = sealGateRecord({
      ...target,
      digest: 'c'.repeat(64),
      capability: 'sandboxExecution',
      verdict: 'GO',
      signedOffBy: 'operator@example.test',
      approvalRef: 'GATE-1',
      signedOffAt: '2026-11-02T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    const guarded = createGuardedSandbox({
      guard: createCapabilityGuard([record]),
      context: target,
      sandbox: createFakeSandbox(),
      now: () => now,
    });
    await expect(guarded.run(request)).rejects.toMatchObject({ reason: 'digest-mismatch' });
  });
});
