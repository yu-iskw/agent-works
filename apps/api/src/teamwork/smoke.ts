// One bounded live Vertex call from inside a segment API container, through the same gate and
// ledger the product uses. Prints sanitized metadata as one JSON line; exits non-zero unless the
// configured model answered. `node apps/api/dist/teamwork/smoke.js`
import { openDatabase } from '../db.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';
import { ModelError } from '../workbench/model-port.js';
import { createVertexModel, readVertexConfig } from '../workbench/vertex.js';

import { readSegmentConfig } from './config.js';
import { createModelGate } from './model.js';

const env = process.env;
const config = readSegmentConfig(env);
if (env.LLM_MODE !== 'vertex') {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: 'live_calls_disabled', llmMode: env.LLM_MODE ?? null })}\n`,
  );
  process.exit(2);
}
const vertex = readVertexConfig(env);
if ('missing' in vertex) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: 'not_configured', missing: vertex.missing })}\n`,
  );
  process.exit(2);
}
const sql = await openDatabase(config.databaseUrl);
await applyWorkbenchMigration(sql);
const gate = createModelGate({
  sql,
  segment: config.segment,
  model: createVertexModel(vertex),
  limit: config.maxModelCalls,
  now: () => new Date(),
});
const at = new Date().toISOString();
try {
  const result = await gate.generate(
    { taskId: null, assignmentId: null, purpose: 'smoke' },
    // Gemini 3.8 counts thinking tokens against this cap; at 64 the visible reply can be empty.
    { system: 'Reply with the single word ok.', prompt: 'ok?', maxOutputTokens: 1024 },
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      at,
      segment: config.segment,
      project: vertex.project,
      location: vertex.location,
      configuredModel: vertex.modelId,
      modelVersion: result.modelVersion,
      responseId: result.responseId ?? null,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason ?? null,
      ledgerCallId: result.callId,
      callsUsed: await gate.used(),
      callsLimit: gate.limit,
      reply: result.text.trim().slice(0, 20),
    })}\n`,
  );
  await sql.end();
} catch (error) {
  const code = error instanceof ModelError ? error.code : 'internal_error';
  process.stdout.write(
    `${JSON.stringify({ ok: false, at, segment: config.segment, error: code })}\n`,
  );
  await sql.end();
  process.exit(1);
}
