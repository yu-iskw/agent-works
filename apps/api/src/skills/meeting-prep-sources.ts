import {
  sourceDataSchema,
  permitsClassification,
  governanceClassificationSchema,
} from '@agent-works/domain/data-governance';

import { ConnectorError } from '../connectors/errors.js';

import type { ClassifiedSource } from '../connectors/source-data.js';
import type { GovernanceClassification } from '@agent-works/domain/data-governance';

export function meetingSources(
  sources: readonly ClassifiedSource[],
  ceiling: GovernanceClassification,
): readonly ClassifiedSource[] {
  for (const source of sources) {
    if (
      !permitsClassification(ceiling, governanceClassificationSchema.parse(source.classification))
    )
      throw new ConnectorError('POLICY_DENIED', 403);
    const body: unknown = JSON.parse(source.body);
    const title: unknown = JSON.parse(source.title);
    if (!sourceDataSchema.safeParse(body).success || !sourceDataSchema.safeParse(title).success)
      throw new ConnectorError('POLICY_DENIED', 403);
  }
  return sources;
}
