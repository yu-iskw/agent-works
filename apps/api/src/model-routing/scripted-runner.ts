import { createScriptedRunner } from '../agent/scripted-runner.js';
import { beforeModelCall } from '../suspension/runtime.js';

import type { InferenceContext, ModelRouter } from './router.js';
import type { AgentRunner } from '../agent/runner-port.js';
import type { ScriptedRunnerOptions } from '../agent/scripted-runner.js';
/** Offline adapter only. Suspension precedes the new authorization hook for every attempted inference. */
export function createRoutedScriptedRunner(
  options: ScriptedRunnerOptions,
  router: ModelRouter,
  context: InferenceContext,
): AgentRunner {
  return {
    run(input) {
      return router.run(context, async (model) => {
        const runner = createScriptedRunner({ ...options, model: model.modelId });
        return runner.run({
          ...input,
          beforeModelCall: async (selected) => {
            await (input.beforeModelCall ?? beforeModelCall)(selected);
            await input.authorizeModelCall?.(selected);
          },
        });
      });
    },
  };
}
