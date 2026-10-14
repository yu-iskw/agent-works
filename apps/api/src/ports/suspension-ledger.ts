import { canonicalPayloadSha256, suspensionAuditSchema } from '@agent-works/domain';

import type {
  CapabilityVersion,
  CapabilityVersionCommand,
  Suspension,
  SuspensionCommand,
} from '@agent-works/domain';

export type AdminCommand =
  | { readonly kind: 'suspension'; readonly command: SuspensionCommand }
  | { readonly kind: 'version'; readonly command: CapabilityVersionCommand };
export type SuspensionAudit = {
  readonly eventId: string;
  readonly eventType: 'admin.suspend' | 'admin.resume' | 'admin.version' | 'invocation.denied';
  readonly actorSub: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly digest: string;
  readonly taskId: string | null;
  readonly traceId: string;
  readonly details: unknown;
};
export type SuspensionSnapshot = {
  readonly suspensions: readonly Suspension[];
  readonly versions: readonly CapabilityVersion[];
};
export type AdminResult = {
  readonly record: Suspension | CapabilityVersion;
  readonly replay: boolean;
};
export class SuspensionConflict extends Error {
  constructor(message = 'stale revision') {
    super(message);
    this.name = 'SuspensionConflict';
  }
}
export interface SuspensionLedger {
  snapshot(): Promise<SuspensionSnapshot>;
  history(): Promise<readonly SuspensionAudit[]>;
  change(input: AdminCommand, actorSub: string, at: Date): Promise<AdminResult>;
  deny(event: SuspensionAudit): Promise<void>;
}
export function commandDigest(input: AdminCommand, actorSub: string): string {
  return canonicalPayloadSha256({ input, actorSub });
}

export function validateDenial(event: SuspensionAudit): SuspensionAudit {
  const parsed = suspensionAuditSchema.parse(event);
  if (parsed.eventType !== 'invocation.denied')
    throw new SuspensionConflict('denial event required');
  return parsed;
}
