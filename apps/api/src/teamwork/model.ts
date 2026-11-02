import { isRequestedModel } from '@agent-works/domain/teamwork-evidence';

import { ModelError } from '../workbench/model-port.js';

import type {
  GenerateRequest,
  GenerateResult,
  ModelErrorCode,
  ModelPort,
} from '../workbench/model-port.js';
import type postgres from 'postgres';

type Purpose = 'plan' | 'contribution' | 'synthesis' | 'revision' | 'reply' | 'smoke';

export type CallContext = {
  readonly taskId: string | null;
  readonly assignmentId: string | null;
  readonly purpose: Purpose;
};

export type GatedResult = GenerateResult & { readonly callId: number; readonly modelId: string };

export type ModelGate = {
  readonly modelId: string;
  /** `stub` only for the scripted UI-review model; never counted against the Vertex budget. */
  readonly mode: 'vertex' | 'stub';
  readonly configured: boolean;
  readonly limit: number;
  /** The allowance the limit applies to; null counts the calls made before campaigns existed. */
  readonly campaign: string | null;
  generate(context: CallContext, request: GenerateRequest): Promise<GatedResult>;
  used(): Promise<number>;
};

/** Errors worth one more paid attempt; auth, config and policy errors never are. */
const TRANSIENT: ReadonlySet<ModelErrorCode> = new Set(['rate_limited', 'unavailable']);
const MAX_ATTEMPTS = 2;
const LOCK = 7018;

type ModelGateOptions = {
  readonly sql: postgres.Sql;
  readonly segment: string;
  readonly model: ModelPort | undefined;
  readonly limit: number;
  readonly campaign?: string | null;
  readonly now: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Every Vertex request goes through here. A ledger row is reserved under an advisory lock before
 * the request leaves the process, so concurrent workers cannot overshoot the cap, a retry is a
 * second row, and a restart cannot reset the count. The returned model must be the configured one.
 */
export function createModelGate(options: ModelGateOptions): ModelGate {
  const { sql, segment, model, limit } = options;
  const campaign = options.campaign ?? null;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function used(): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from wb_model_calls
      where mode = 'vertex' and sent and segment = ${segment} and campaign is not distinct from ${campaign}
    `;
    return rows.at(0)?.n ?? 0;
  }

  async function reserve(context: CallContext, port: ModelPort): Promise<number> {
    return sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK})`;
      const rows = await tx<{ n: number }[]>`
        select count(*)::int as n from wb_model_calls
      where mode = 'vertex' and sent and segment = ${segment} and campaign is not distinct from ${campaign}
      `;
      if ((rows.at(0)?.n ?? 0) >= limit) throw new ModelError('budget_exhausted', false);
      const inserted = await tx<{ id: number }[]>`
        insert into wb_model_calls (task_id, mode, model_id, outcome, sent, at, segment, assignment_id, purpose, campaign)
        values (${context.taskId}, ${port.mode}, ${port.modelId}, 'pending', true, ${options.now()}, ${segment},
          ${context.assignmentId}, ${context.purpose}, ${campaign})
        returning id
      `;
      return Number(inserted[0].id);
    });
  }

  async function settle(
    id: number,
    outcome: string,
    sent: boolean,
    result?: GenerateResult,
  ): Promise<void> {
    await sql`
      update wb_model_calls set outcome = ${outcome}, sent = ${sent},
        model_version = ${result?.modelVersion ?? null}, response_id = ${result?.responseId ?? null},
        latency_ms = ${result?.latencyMs ?? null}, prompt_tokens = ${result?.promptTokens ?? null},
        output_tokens = ${result?.outputTokens ?? null}
      where id = ${id}
    `;
  }

  async function attempt(
    context: CallContext,
    port: ModelPort,
    request: GenerateRequest,
  ): Promise<GatedResult> {
    const id = await reserve(context, port);
    let result: GenerateResult;
    try {
      result = await port.generate(request);
    } catch (error) {
      if (error instanceof ModelError) await settle(id, error.code, error.sent);
      else await settle(id, 'internal_error', true);
      throw error;
    }
    if (!isRequestedModel(port.modelId, result.modelVersion)) {
      await settle(id, 'model_mismatch', true, result);
      throw new ModelError('model_not_found');
    }
    await settle(id, 'ok', true, result);
    return { ...result, callId: id, modelId: port.modelId };
  }

  return {
    modelId: model?.modelId ?? 'unconfigured',
    mode: model?.mode ?? 'vertex',
    configured: model !== undefined,
    limit,
    campaign,
    used,
    async generate(context, request) {
      if (model === undefined) throw new ModelError('not_configured', false);
      for (let tries = 1; ; tries += 1) {
        try {
          return await attempt(context, model, request);
        } catch (error) {
          const retry =
            error instanceof ModelError && TRANSIENT.has(error.code) && tries < MAX_ATTEMPTS;
          if (!retry) throw error;
          await sleep(1500 * tries);
        }
      }
    },
  };
}
