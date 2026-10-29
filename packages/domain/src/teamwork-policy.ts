import { CAPABILITIES, CAPABILITY_PROVIDER, SOURCE_CAPABILITY } from './teamwork.js';

import type { Capability, CapabilityState, SourceKind } from './teamwork.js';

export type Provider = 'google' | 'github';

export type CapabilityInputs = {
  /** What the segment allows anyone to do. */
  readonly segment: ReadonlySet<Capability>;
  /** What this member may do in the segment (membership entitlement). */
  readonly member: ReadonlySet<Capability>;
  /** What the teammate asks for (template request, kept on copies and imports). */
  readonly teammate: ReadonlySet<Capability>;
  /** Providers the member has connected in this segment with the needed scope. */
  readonly connected: ReadonlySet<Provider>;
  /** Capabilities the task scope needs; undefined when no task narrows the set. */
  readonly task?: ReadonlySet<Capability>;
};

/**
 * The effective intersection. Delegation can only narrow it: an assignment's capabilities are
 * computed from its teammate and its task, never from text a model produced.
 */
export function capabilityStates(inputs: CapabilityInputs): readonly CapabilityState[] {
  return CAPABILITIES.map((capability) => {
    const requested = inputs.teammate.has(capability);
    const permitted = inputs.segment.has(capability) && inputs.member.has(capability);
    // eslint-disable-next-line security/detect-object-injection
    const connected = inputs.connected.has(CAPABILITY_PROVIDER[capability]);
    const inTask = inputs.task === undefined || inputs.task.has(capability);
    const effective = requested && permitted && connected && inTask;
    return { capability, requested, permitted, connected, effective, reason: reason() };

    function reason(): string | null {
      if (!requested) return 'The teammate does not request this capability.';
      if (!inputs.segment.has(capability)) return 'This segment does not allow it.';
      if (!inputs.member.has(capability))
        return 'Your membership in this segment does not include it.';
      if (!connected)
        // eslint-disable-next-line security/detect-object-injection
        return `Connect ${CAPABILITY_PROVIDER[capability] === 'google' ? 'Google' : 'GitHub'} in this segment.`;
      if (!inTask) return 'Not needed by this task.';
      return null;
    }
  });
}

export function effectiveSet(states: readonly CapabilityState[]): ReadonlySet<Capability> {
  return new Set(states.filter((state) => state.effective).map((state) => state.capability));
}

export function capabilitiesForSources(sources: readonly SourceKind[]): ReadonlySet<Capability> {
  // eslint-disable-next-line security/detect-object-injection
  return new Set(sources.map((source) => SOURCE_CAPABILITY[source]));
}

export type SourceDenial = {
  readonly source: SourceKind;
  readonly capability: Capability;
  readonly reason: string;
};

/** Which requested sources the effective set cannot reach, with the member-facing reason. */
export function deniedSources(
  sources: readonly SourceKind[],
  states: readonly CapabilityState[],
): readonly SourceDenial[] {
  return sources.flatMap((source) => {
    // eslint-disable-next-line security/detect-object-injection
    const capability = SOURCE_CAPABILITY[source];
    const state = states.find((item) => item.capability === capability);
    if (state === undefined || state.effective) return [];
    return [{ source, capability, reason: state.reason ?? 'Not available.' }];
  });
}

/** owner/name match against the segment allowlist, case-insensitive like GitHub. */
export function repositoryAllowed(repository: string, allowlist: readonly string[]): boolean {
  const wanted = repository.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === wanted);
}
