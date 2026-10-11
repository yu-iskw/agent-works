import { POLICY_CLAUSES } from '@agent-works/domain';

import type { PolicyFacts } from './decide.js';
import type { PolicyClause } from '@agent-works/domain';

const clauseNames = new Set<string>(POLICY_CLAUSES);

function isClause(key: string): key is PolicyClause {
  return clauseNames.has(key);
}

export function parseFacts(value: unknown): PolicyFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('facts must be an object');
  }
  const entries = Object.entries(value) as [string, unknown][];
  let facts: PolicyFacts = {};
  for (const [key, bit] of entries) {
    if (!isClause(key) || typeof bit !== 'boolean') throw new Error('invalid fact');
    facts = { ...facts, [key]: bit };
  }
  return facts;
}
