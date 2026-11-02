import { Gemini } from '@google/adk';

import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';

export type VertexConfig = {
  readonly project: string;
  readonly location: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
};

export function readVertexConfig(
  env: Readonly<Record<string, string | undefined>>,
): VertexConfig | { readonly missing: readonly string[] } {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() ?? '';
  const location = env.GOOGLE_CLOUD_LOCATION?.trim() ?? '';
  const modelId = env.VERTEX_MODEL_ID?.trim() ?? '';
  const missing = [
    ...(project ? [] : ['GOOGLE_CLOUD_PROJECT']),
    ...(location ? [] : ['GOOGLE_CLOUD_LOCATION']),
    ...(modelId ? [] : ['VERTEX_MODEL_ID']),
  ];
  if (missing.length > 0) return { missing };
  return {
    project,
    location,
    modelId,
    timeoutMs: positive(env.VERTEX_TIMEOUT_MS, 60_000),
    maxOutputTokens: positive(env.VERTEX_MAX_OUTPUT_TOKENS, 4096),
  };
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Returns the config, or throws an error naming every missing variable. */
export function requireVertexConfig(
  env: Readonly<Record<string, string | undefined>>,
): VertexConfig {
  const config = readVertexConfig(env);
  if ('missing' in config) {
    throw new Error(
      `Live mode needs ${config.missing.join(', ')} to be set (Vertex AI with Application Default Credentials).`,
    );
  }
  return config;
}

/** Applies the configured output cap and per-attempt timeout to every outgoing request. */
class BoundedGemini extends Gemini {
  private readonly bounds: Pick<VertexConfig, 'timeoutMs' | 'maxOutputTokens'>;

  constructor(
    params: ConstructorParameters<typeof Gemini>[0],
    bounds: Pick<VertexConfig, 'timeoutMs' | 'maxOutputTokens'>,
  ) {
    super(params);
    this.bounds = bounds;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    llmRequest.config = {
      ...llmRequest.config,
      maxOutputTokens: this.bounds.maxOutputTokens,
      httpOptions: { ...llmRequest.config?.httpOptions, timeout: this.bounds.timeoutMs },
    };
    yield* super.generateContentAsync(llmRequest, stream, abortSignal);
  }
}

/** Vertex AI through Application Default Credentials only; there is no API-key path. */
export function createLiveModel(config: VertexConfig): BaseLlm {
  return new BoundedGemini(
    {
      vertexai: true,
      project: config.project,
      location: config.location,
      model: config.modelId,
    },
    config,
  );
}
