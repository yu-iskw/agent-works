import { capabilityKey, suspensionActive } from '@agent-works/domain';

import type { CapabilityPin, CapabilityVersion, Suspension } from '@agent-works/domain';

export type InvocationContext = {
  readonly subject: string;
  readonly teams: readonly string[];
  readonly agent: CapabilityPin;
  readonly skill: CapabilityPin;
  readonly model: string;
  readonly tool?: CapabilityPin;
  readonly taskId: string;
  readonly traceId: string;
};
export type SuspensionFacts = {
  readonly storeReachable: boolean;
  readonly contextComplete: boolean;
  readonly suspended: boolean;
  readonly versionsPublished: boolean;
  readonly revoked: boolean;
};
export type SuspensionDenial =
  | 'SUSPENSION_STORE_UNAVAILABLE'
  | 'SUSPENSION_CONTEXT_MISSING'
  | 'CAPABILITY_VERSION_REVOKED'
  | 'CAPABILITY_VERSION_UNPUBLISHED'
  | 'INVOCATION_SUSPENDED';

export function suspensionDecision(facts: Partial<SuspensionFacts>): SuspensionDenial | undefined {
  if (facts.storeReachable !== true) return 'SUSPENSION_STORE_UNAVAILABLE';
  if (facts.contextComplete !== true) return 'SUSPENSION_CONTEXT_MISSING';
  if (facts.revoked !== false) return 'CAPABILITY_VERSION_REVOKED';
  if (facts.suspended !== false) return 'INVOCATION_SUSPENDED';
  if (facts.versionsPublished !== true) return 'CAPABILITY_VERSION_UNPUBLISHED';
  return undefined;
}

export function suspensionFacts(
  context: InvocationContext,
  suspensions: readonly Suspension[],
  versions: readonly CapabilityVersion[],
  at: Date,
): SuspensionFacts {
  const pins = [
    context.agent,
    context.skill,
    ...(context.tool === undefined ? [] : [context.tool]),
  ];
  const states = pins.map(
    (pin) => versions.find((value) => capabilityKey(value.pin) === capabilityKey(pin))?.state,
  );
  return {
    storeReachable: true,
    contextComplete:
      context.subject.length > 0 && context.model.length > 0 && context.taskId.length > 0,
    suspended: suspensions.some((value) => suspensionActive(value, at) && matches(value, context)),
    versionsPublished: states.every((state) => state === 'published' || state === 'deprecated'),
    revoked: states.includes('revoked'),
  };
}

function matches(value: Suspension, context: InvocationContext): boolean {
  const target = value.target;
  switch (target.scope) {
    case 'global':
      return true;
    case 'user':
      return target.id === context.subject;
    case 'team':
      return context.teams.includes(target.id);
    case 'model':
      return target.id === context.model;
    case 'agent':
      return pinMatches(target, context.agent);
    case 'skill':
      return pinMatches(target, context.skill);
    case 'tool':
      return context.tool !== undefined && pinMatches(target, context.tool);
  }
}
function pinMatches(target: Suspension['target'], pin: CapabilityPin): boolean {
  return target.id === pin.id && (target.version === null || target.version === pin.version);
}
