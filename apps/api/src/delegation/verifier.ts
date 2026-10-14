import { canonicalPayloadSha256 } from '@agent-works/domain';

import type { RunnerOutput } from '../agent/runner-port.js';
import type { DelegationContext } from '@agent-works/domain/delegation';
type Verification = { readonly accepted: boolean; readonly verifierRef: string };
export interface ChildVerifier {
  verify(context: DelegationContext, result: RunnerOutput): Promise<Verification>;
}
/** A deterministic verifier has a separate trust role from the executing child. */
export function citationVerifier(
  sources: ReadonlyMap<string, string>,
  verifierRef: string,
): ChildVerifier {
  const trusted = new Map(sources);
  return {
    verify(context, result) {
      const cited = result.citedSourceIds;
      const allowed = new Set(
        context.authority.grants
          .filter((grant) => grant.capability === 'drive.read')
          .map((grant) => grant.resource),
      );
      const supported = cited.every((id) => allowed.has(id) && trusted.has(id));
      const expected = cited.map((id) => `${trusted.get(id) ?? ''} [${id}]`).join('\n');
      const accepted =
        cited.length > 0 &&
        new Set(cited).size === cited.length &&
        supported &&
        result.answer === expected &&
        result.answer.length <= 20000;
      return Promise.resolve({ accepted, verifierRef });
    },
  };
}
export function resultDigest(result: RunnerOutput): string {
  return canonicalPayloadSha256(result);
}
