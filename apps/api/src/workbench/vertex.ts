import { GoogleAuth } from 'google-auth-library';

import { ModelError } from './model-port.js';

import type { GenerateRequest, GenerateResult, ModelPort } from './model-port.js';

export type VertexConfig = {
  readonly project: string;
  readonly location: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
};

type Headers = Readonly<Record<string, string>>;

export type VertexDeps = {
  readonly authHeaders?: () => Promise<Headers>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
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

export function vertexEndpoint(config: VertexConfig): string {
  const host =
    config.location === 'global'
      ? 'aiplatform.googleapis.com'
      : `${config.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${config.project}/locations/${config.location}/publishers/google/models/${config.modelId}:generateContent`;
}

export function createVertexModel(config: VertexConfig, deps: VertexDeps = {}): ModelPort {
  const load = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const authHeaders = deps.authHeaders ?? adcHeaders();
  const url = vertexEndpoint(config);
  return {
    mode: 'vertex',
    modelId: config.modelId,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      let headers: Headers;
      try {
        headers = await authHeaders();
      } catch {
        throw new ModelError('adc_unavailable', false);
      }
      const started = now();
      let response: Response;
      try {
        response = await load(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body(config, request)),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw name === 'TimeoutError'
          ? new ModelError('timeout')
          : new ModelError('unreachable', false);
      }
      const payload = (await response.json().catch(() => undefined)) as VertexBody | undefined;
      if (!response.ok) throw new ModelError(classify(response.status, payload));
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('');
      if (text === undefined || text.length === 0) throw new ModelError('empty_response');
      return {
        text,
        modelVersion: payload?.modelVersion ?? config.modelId,
        responseId: payload?.responseId,
        latencyMs: now() - started,
        finishReason: payload?.candidates?.[0]?.finishReason,
        promptTokens: payload?.usageMetadata?.promptTokenCount,
        outputTokens: payload?.usageMetadata?.candidatesTokenCount,
      };
    },
  };
}

type VertexBody = {
  readonly modelVersion?: string;
  readonly responseId?: string;
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
  readonly error?: { readonly status?: string; readonly message?: string };
};

function body(config: VertexConfig, request: GenerateRequest) {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig: {
      maxOutputTokens: Math.min(
        request.maxOutputTokens ?? config.maxOutputTokens,
        config.maxOutputTokens,
      ),
      temperature: 0.2,
      ...(request.jsonSchema === undefined
        ? {}
        : { responseMimeType: 'application/json', responseSchema: request.jsonSchema }),
    },
  };
}

function classify(status: number, payload: VertexBody | undefined): ModelError['code'] {
  const reason = payload?.error?.status ?? '';
  const message = payload?.error?.message ?? '';
  if (status === 401) return 'adc_unavailable';
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') return 'rate_limited';
  if (status === 404) return 'model_not_found';
  if (status === 403) return forbiddenCode(message);
  if (status === 400) return 'bad_request';
  if (status === 504) return 'timeout';
  return 'unavailable';
}

function forbiddenCode(message: string): ModelError['code'] {
  if (/billing/i.test(message)) return 'billing_disabled';
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message)) return 'api_disabled';
  return 'permission_denied';
}

function adcHeaders(): () => Promise<Headers> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return async () => {
    const client = await auth.getClient();
    const raw: unknown = await client.getRequestHeaders();
    if (raw instanceof globalThis.Headers) return Object.fromEntries(raw.entries());
    return raw as Headers;
  };
}
