import type { SealedExport, SiemEvent } from './format.js';

export interface SiemSink {
  /** Atomically append, or return the identical existing event; changed identities fail. */
  append(event: SiemEvent): Promise<SealedExport>;
  read(): Promise<readonly SealedExport[]>;
}
export function existingExport(
  links: readonly SealedExport[],
  event: SiemEvent,
): SealedExport | undefined {
  const prior = links.find((link) => link.event.event_id === event.event_id);
  if (prior !== undefined && JSON.stringify(prior.event) !== JSON.stringify(event))
    throw new Error('SIEM event identity conflict');
  return prior;
}
