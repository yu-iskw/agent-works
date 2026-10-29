import { ModelError } from './model-port.js';
import { createVertexModel, readVertexConfig } from './vertex.js';

// G1 real-model check, run inside the api container: one bounded call through the production
// adapter. Fails closed on stub mode, missing config, or a model other than the configured one.
// Prints only non-secret metadata.
function fail(error: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(1);
}

if (process.env.LLM_MODE === 'stub') fail('stub_mode', { mode: 'stub' });
const config = readVertexConfig(process.env);
if ('missing' in config) fail('not_configured', { missing: config.missing });
const model = createVertexModel({ ...config, maxOutputTokens: 256 });
const transient = new Set(['timeout', 'unavailable', 'rate_limited', 'unreachable']);
const request = {
  system: 'You are a connectivity check. Answer with one lowercase word.',
  prompt: 'Reply with: ok',
};
let attempts = 1;
try {
  // One retry for a transient failure; never more, to keep the call budget predictable.
  const result = await model.generate(request).catch((error: unknown) => {
    if (!(error instanceof ModelError) || !transient.has(error.code)) throw error;
    attempts = 2;
    return model.generate(request);
  });
  if (model.mode !== 'vertex') fail('not_vertex');
  if (!result.modelVersion.startsWith(config.modelId))
    fail('model_mismatch', { configuredModel: config.modelId, modelVersion: result.modelVersion });
  if (result.responseId === undefined) fail('no_response_id');
  console.log(
    JSON.stringify({
      ok: true,
      mode: model.mode,
      attempts,
      at: new Date().toISOString(),
      project: config.project,
      location: config.location,
      configuredModel: config.modelId,
      modelVersion: result.modelVersion,
      responseId: result.responseId,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
      reply: result.text.trim().slice(0, 20),
    }),
  );
} catch (error) {
  fail(error instanceof ModelError ? error.code : 'unexpected', { attempts });
}
