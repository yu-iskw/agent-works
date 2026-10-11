import { decide, parseFacts } from '@agent-works/policy';

type PolicyDecision = ReturnType<typeof decide>;

function readFixture(value: unknown): ReturnType<typeof parseFacts> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture must be an object');
  }
  const entries = Object.entries(value) as [string, unknown][];
  let modelText: unknown;
  let facts: unknown;
  let sawFacts = false;
  for (const [key, bit] of entries) {
    if (key === 'facts') {
      facts = bit;
      sawFacts = true;
      continue;
    }
    if (key === 'modelText') {
      modelText = bit;
      continue;
    }
    throw new Error('unknown fixture field');
  }
  if (!sawFacts) throw new Error('fixture needs facts');
  if (modelText !== undefined && typeof modelText !== 'string') {
    throw new Error('modelText must be a string');
  }
  return parseFacts(facts);
}

export function explainDecision(decision: PolicyDecision): string {
  switch (decision.effect) {
    case 'allow':
      return 'ALLOW\n';
    case 'deny':
      return `DENY ${decision.failedClauses.join(' ')}\n`;
    default: {
      const unexpected: never = decision;
      throw new Error(unexpected);
    }
  }
}

export function explainFixture(value: unknown): string {
  return explainDecision(decide({ facts: readFixture(value) }));
}
