import { canonicalPayloadSha256 } from '@agent-works/domain';
import { z } from 'zod';

import type { ExecutionLimits, ProbeKind, SandboxPort } from './sandbox-contract.js';

export const MATRIX_CASES = [
  'metadata-exfiltration',
  'credential-exfiltration',
  'unexpected-egress',
  'filesystem-escape',
  'resource-exhaustion',
  'cleanup',
] as const;
type MatrixCaseId = (typeof MATRIX_CASES)[number];

const RESOURCES: MatrixCaseId = 'resource-exhaustion';
const probesByCase = new Map<MatrixCaseId, readonly ProbeKind[]>([
  ['metadata-exfiltration', ['metadata-fetch']],
  ['credential-exfiltration', ['credential-read']],
  ['unexpected-egress', ['egress-connect']],
  ['filesystem-escape', ['host-file-read']],
  [RESOURCES, ['memory-bomb', 'cpu-spin', 'wall-hang']],
  ['cleanup', ['none', 'wall-hang', 'emit-artifact']],
]);

const limits: ExecutionLimits = {
  cpuMs: 1_000,
  memoryBytes: 64 * 1024 * 1024,
  wallMs: 2_000,
  outputBytes: 1_048_576,
};

type CaseResult = {
  readonly id: MatrixCaseId;
  readonly outcome: 'held' | 'breached';
  readonly detail: string;
};
export type MatrixReport = {
  /** Always offline here. A live sandbox result enters only through sealed operator evidence. */
  readonly evidenceKind: 'offline-fake';
  readonly cases: readonly CaseResult[];
  readonly allHeld: boolean;
};

/** Runs every hostile probe and fails closed: an adapter that throws counts as a breach of that case. */
export async function runNegativeMatrix(sandbox: SandboxPort): Promise<MatrixReport> {
  const cases: CaseResult[] = [];
  for (const id of MATRIX_CASES) cases.push(await runCase(sandbox, id));
  return {
    evidenceKind: 'offline-fake',
    cases,
    allHeld: cases.every((item) => item.outcome === 'held'),
  };
}

async function runCase(sandbox: SandboxPort, id: MatrixCaseId): Promise<CaseResult> {
  try {
    for (const [index, probe] of (probesByCase.get(id) ?? []).entries()) {
      const executionId = `${id}-${String(index)}`;
      const result = await sandbox.run({
        executionId,
        program: { language: 'python', source: `# synthetic ${probe}` },
        probe,
        limits,
        network: 'none',
      });
      if (id !== RESOURCES && id !== 'cleanup' && result.breach) {
        return { id, outcome: 'breached', detail: `${probe} reached the protected resource` };
      }
      if (id === RESOURCES && result.status !== 'killed-limit') {
        return { id, outcome: 'breached', detail: `${probe} was not stopped by a limit` };
      }
      if (id === 'cleanup' && (await sandbox.residue(executionId)) !== 0) {
        return { id, outcome: 'breached', detail: `${probe} left resources behind` };
      }
    }
    return { id, outcome: 'held', detail: 'offline fake only' };
  } catch {
    return { id, outcome: 'breached', detail: 'adapter error; treated as a breach' };
  }
}

const evidenceBodySchema = z.strictObject({
  probe: z.literal('sandbox'),
  issue: z.literal(111),
  source: z.literal('operator-live'),
  capturedAt: z.iso.datetime(),
  region: z.string().min(1),
  product: z.string().min(1),
  launchStage: z.string().min(1),
  cases: z.partialRecord(z.enum(MATRIX_CASES), z.enum(['held', 'breached'])),
});
const sealedEvidenceSchema = evidenceBodySchema.extend({
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Seals operator-captured evidence. The digest catches accidental edits only and is not proof of truth. */
export function sealSandboxEvidence(body: z.input<typeof evidenceBodySchema>): unknown {
  const parsed = evidenceBodySchema.parse(body);
  return { ...parsed, evidenceDigest: canonicalPayloadSha256(parsed) };
}

export type SandboxGateStatus = {
  readonly status: 'UNTESTED' | 'FAIL' | 'PASS';
  /** DEFER is the default. GO-ELIGIBLE still needs a signed-off gate record before anything runs. */
  readonly verdict: 'DEFER' | 'NO-GO' | 'GO-ELIGIBLE';
  readonly reason: string;
};

const PILOT_REGION = 'asia-northeast1';

/** Offline reports never reach this function's decision: only sealed operator evidence can leave UNTESTED. */
export function assessSandboxEvidence(sealed: unknown): SandboxGateStatus {
  const untested = (reason: string): SandboxGateStatus => ({
    status: 'UNTESTED',
    verdict: 'DEFER',
    reason,
  });
  if (sealed === undefined || sealed === null) return untested('no operator evidence');
  const parsed = sealedEvidenceSchema.safeParse(sealed);
  if (!parsed.success) return untested('evidence is malformed');
  const { evidenceDigest, ...body } = parsed.data;
  if (canonicalPayloadSha256(body) !== evidenceDigest) return untested('evidence digest mismatch');
  const recorded = new Map(Object.entries(body.cases));
  const outcomes = MATRIX_CASES.map((id) => recorded.get(id));
  if (outcomes.includes('breached')) {
    return { status: 'FAIL', verdict: 'NO-GO', reason: 'a control was breached' };
  }
  if (outcomes.includes(undefined)) return untested('matrix cases missing');
  if (body.region !== PILOT_REGION) return untested(`region is not ${PILOT_REGION}`);
  return { status: 'PASS', verdict: 'GO-ELIGIBLE', reason: 'all cases held in operator evidence' };
}
