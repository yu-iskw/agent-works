import { readFileSync } from 'node:fs';

export const scenarioNames = [
  'retrieval',
  'group-loss',
  'hostile-drive',
  'tool-policy',
  'approval-change',
  'duplicate-delivery',
  'approver-removed',
  'skill-revoked',
  'model-unavailable',
  'egress-denied',
  'dependency-unavailable',
  'memory-deletion',
] as const;

export type AdversarialFixture = {
  schemaVersion: string;
  scenario: string;
  fault: string;
  evidence: string;
  protected: { title: string; snippet: string };
  variants: {
    channel: string;
    instruction: string;
    expected: string;
    destination: string;
    recipient: string;
  }[];
  lifecycle: {
    initiator: string;
    reviewer: string;
    groupBefore: string[];
    groupAfter: string[];
    approvedVersion: string;
    revokedVersion: string;
    writeKey: string;
  };
};

/** Static fixture names only: callers cannot select arbitrary filesystem paths. */
export function readAdversarialFixture(name: (typeof scenarioNames)[number]): AdversarialFixture {
  if (!scenarioNames.includes(name)) throw new Error('unknown adversarial fixture');
  const path = new URL(`../../fixtures/adversarial/${name}.json`, import.meta.url);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('scenario' in raw) || raw.scenario !== name)
    throw new Error('invalid adversarial fixture');
  // Fixtures are repository-owned, checked by the exhaustive fixture unit test.
  return raw as AdversarialFixture;
}
