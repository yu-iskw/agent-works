import { permitsClassification, sourceData } from '@agent-works/domain/data-governance';

import { ConnectorError } from './errors.js';

import type { WorkspaceSource } from '../../../../packages/domain/dist/workspace-tools.js';
import type { GovernanceClassification } from '@agent-works/domain/data-governance';
export type ClassifiedSource = WorkspaceSource & { readonly authority: 'none' };
export function classifySources(
  rows: readonly WorkspaceSource[],
  ceiling: GovernanceClassification,
  gmail = false,
): readonly ClassifiedSource[] {
  return rows.map((row) => {
    const classification =
      gmail && row.classification === 'INTERNAL' ? 'CONFIDENTIAL' : row.classification;
    if (!permitsClassification(ceiling, classification))
      throw new ConnectorError('POLICY_DENIED', 403);
    return {
      ...row,
      title: sourceData(row.title),
      body: sourceData(row.body),
      classification,
      authority: 'none',
    };
  });
}
