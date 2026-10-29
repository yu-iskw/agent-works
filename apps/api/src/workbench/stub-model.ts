import { ModelError } from './model-port.js';

import type { ModelErrorCode, ModelPort } from './model-port.js';

const STUB_MODEL_ID = 'stub-offline';

const stubFaults: Readonly<Record<string, ModelErrorCode>> = {
  '[stub:rate-limit]': 'rate_limited',
  '[stub:unavailable]': 'unavailable',
  '[stub:timeout]': 'timeout',
  '[stub:invalid]': 'invalid_output',
};

/**
 * Opt-in offline model (LLM_MODE=stub) for CI and fixture-driven browser tests. It writes a
 * deterministic report from the request's evidence items and is labelled "stub" everywhere.
 * `[stub:*]` markers in the prompt inject faults only when `faultsEnabled`.
 */
export function createStubModel(faultsEnabled: boolean): ModelPort {
  return {
    mode: 'stub',
    modelId: STUB_MODEL_ID,
    async generate(request) {
      if (faultsEnabled) {
        if (request.prompt.includes('[stub:slow]'))
          await new Promise((done) => setTimeout(done, 6000));
        for (const [marker, code] of Object.entries(stubFaults)) {
          if (request.prompt.includes(marker)) throw new ModelError(code);
        }
      }
      const items = request.evidence ?? [];
      const all = items.map((item) => item.id);
      const report = {
        title: 'Incident review (stub model output)',
        summary: `Stub summary covering ${items.length} evidence item(s). This text is generated offline and is not a model analysis.`,
        recurringCauses:
          items.length >= 2
            ? [
                {
                  cause: 'Stub recurring cause',
                  explanation: 'Placeholder cause citing the first two evidence items.',
                  evidenceIds: all.slice(0, 2),
                },
              ]
            : [],
        incidents: items.map((item) => ({ evidenceId: item.id, oneLine: item.title })),
        recommendations:
          items.length > 0
            ? [{ text: 'Stub recommendation citing the first item.', evidenceIds: all.slice(0, 1) }]
            : [],
        gaps: items.length === 0 ? ['No evidence was retrieved.'] : [],
      };
      return {
        text: JSON.stringify(report),
        modelVersion: STUB_MODEL_ID,
        latencyMs: 0,
        finishReason: 'STOP',
      };
    },
  };
}
