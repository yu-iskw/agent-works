import type { OutboxEvent } from '@agent-works/domain';

export interface ExporterPort {
  exportEvent(event: OutboxEvent): Promise<'exported' | 'duplicate'>;
}
