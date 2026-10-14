import { privilegeWithin } from '../../../../packages/domain/dist/schedule.js';

import type { ScheduleSpec, SchedulePrivilege } from '../../../../packages/domain/dist/schedule.js';
import type { SearchContext } from '@agent-works/domain';
export type SponsorAuthority = {
  active: boolean;
  subject: string;
  teams: readonly string[];
  privilege: SchedulePrivilege;
  context: SearchContext;
};
export type AuthorityResolver = (spec: ScheduleSpec) => Promise<SponsorAuthority>;
export type ConsentRegistry = {
  valid(ref: string, subject: string, digest: string, at: Date): Promise<boolean>;
};
export class ScheduleDenied extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ScheduleDenied';
  }
}
export async function checkAuthority(
  spec: ScheduleSpec,
  digest: string,
  at: Date,
  deps: { authority: AuthorityResolver; consent: ConsentRegistry },
): Promise<SponsorAuthority> {
  const current = await deps.authority(spec);
  if (!current.active || current.subject !== spec.sponsor.sub)
    throw new ScheduleDenied('SPONSOR_DEPROVISIONED');
  if (!privilegeWithin(spec.maxPrivilege, current.privilege))
    throw new ScheduleDenied('SPONSOR_AUTHORITY_LOST');
  if (!(await deps.consent.valid(spec.consentRef, spec.sponsor.sub, digest, at)))
    throw new ScheduleDenied('CONSENT_REVOKED');
  return current;
}
export function pinnedContext(spec: ScheduleSpec, current: SponsorAuthority): SearchContext {
  return {
    ...current.context,
    userSubject: spec.sponsor.sub,
    taskPurpose: spec.purpose,
    allowedSources: [...spec.task.sourceAllowlist],
    classificationCeiling: spec.maxPrivilege.classification,
    allowedRegions: [...spec.maxPrivilege.regions],
  };
}
