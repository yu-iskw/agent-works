import type { ExporterPort } from '../exporter-port.js';
import type { OutboxEvent } from '@agent-works/domain';

export function createMemoryExporterPort(): ExporterPort {
  const seen = new Set<string>();
  return {
    exportEvent(event: OutboxEvent) {
      if (seen.has(event.event.eventId)) return Promise.resolve('duplicate');
      seen.add(event.event.eventId);
      return Promise.resolve('exported');
    },
  };
}
