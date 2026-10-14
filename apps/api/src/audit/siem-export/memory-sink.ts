import { sealExport, siemEventSchema, verifyExports } from './format.js';
import { existingExport } from './sink-port.js';

import type { SealedExport } from './format.js';
import type { SiemSink } from './sink-port.js';

export function createMemorySiemSink(seed: readonly SealedExport[] = []): SiemSink {
  verifyExports(seed);
  const links: SealedExport[] = structuredClone([...seed]);
  return {
    append(input) {
      const event = siemEventSchema.parse(input);
      const existing = existingExport(links, event);
      if (existing !== undefined) return Promise.resolve(structuredClone(existing));
      const link = sealExport(event, links.at(-1));
      links.push(link);
      return Promise.resolve(structuredClone(link));
    },
    read() {
      return Promise.resolve(structuredClone(links));
    },
  };
}
