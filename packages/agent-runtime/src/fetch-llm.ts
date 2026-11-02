import { BaseLlm } from '@google/adk';
import * as z from 'zod';

import { RunnerError } from './runner-port.js';

import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

const textPartSchema = z.object({ text: z.string().min(1) }).strict();
const callPartSchema = z
  .object({ functionCall: z.object({ name: z.string().min(1) }).passthrough() })
  .strict();
const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.union([textPartSchema, callPartSchema])).min(1),
        }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
});

export type FetchLlmOptions = {
  readonly baseUrl: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
};

/** Fake/dev model: posts generateContent over an injected fetch and opens no socket of its own. */
export class FetchLlm extends BaseLlm {
  private readonly baseUrl: string;
  private readonly load: typeof fetch;

  constructor(options: FetchLlmOptions) {
    super({ model: options.model ?? 'gemini' });
    this.baseUrl = options.baseUrl;
    this.load = options.fetch ?? fetch;
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    let response: Response;
    try {
      response = await this.load(
        new URL(`/v1beta/models/${this.model}:generateContent`, this.baseUrl),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: request.contents.map(({ role, parts }) => ({ role, parts })),
          }),
        },
      );
    } catch (error) {
      throw new RunnerError('llm unreachable', { cause: error });
    }
    if (!response.ok) throw new RunnerError('llm status');
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch (error) {
      throw new RunnerError('llm body', { cause: error });
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new RunnerError('llm shape');
    yield {
      content: { role: 'model', parts: [parsed.data.candidates[0].content.parts[0]] },
      ...(parsed.data.usageMetadata === undefined
        ? {}
        : { usageMetadata: parsed.data.usageMetadata }),
    };
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new RunnerError('llm live connection unsupported'));
  }
}
