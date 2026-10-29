import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import {
  workbenchErrorSchema,
  workbenchReadinessSchema,
  workbenchTaskDetailSchema,
  workbenchTaskListSchema,
  workbenchTaskSummarySchema,
} from '@agent-works/domain/workbench';
import * as z from 'zod';

import type {
  WorkbenchCreate,
  WorkbenchDecision,
  WorkbenchReadiness,
  WorkbenchTaskDetail,
  WorkbenchTaskSummary,
} from '@agent-works/domain/workbench';

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** Create and every command answer with the task summary. */
const taskReplySchema = z.object({ task: workbenchTaskSummarySchema });
const sourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  modifiedAt: z.string(),
  body: z.string(),
  simulated: z.literal(true),
});
const docSchema = z.object({
  docId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  simulated: z.literal(true),
  body: z.object({
    title: z.string(),
    sections: z.array(z.object({ heading: z.string(), lines: z.array(z.string()) })),
    sources: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
});

export type FixtureSource = z.infer<typeof sourceSchema>;
export type FixtureDocument = z.infer<typeof docSchema>;

/** Thin BFF client: forwards the caller's IAP assertion; the API is the only authority. */
export function createWorkbenchApi(apiUrl: string, load: typeof fetch = fetch) {
  async function call<T>(
    assertion: string | undefined,
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await load(new URL(path, apiUrl), {
        method,
        headers: {
          ...(assertion === undefined ? {} : { [IAP_ASSERTION_HEADER]: assertion }),
          ...(method === 'POST'
            ? { 'content-type': 'application/json', 'x-csrf-token': 'bff' }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { ok: false, status: 503, error: 'unavailable' };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, status: 502, error: 'bad_contract' };
    }
    const error = workbenchErrorSchema.safeParse(payload);
    return {
      ok: false,
      status: response.status,
      error: error.success ? error.data.error : 'unexpected',
    };
  }
  async function post(
    assertion: string | undefined,
    path: string,
    body: unknown,
  ): Promise<ApiResult<WorkbenchTaskSummary>> {
    const result = await call(assertion, 'POST', path, taskReplySchema, body);
    return result.ok ? { ok: true, value: result.value.task } : result;
  }
  const task = (id: string) => `/v1/workbench/tasks/${encodeURIComponent(id)}`;
  return {
    readiness: (assertion: string | undefined): Promise<ApiResult<WorkbenchReadiness>> =>
      call(assertion, 'GET', '/v1/workbench/readiness', workbenchReadinessSchema),
    list: async (
      assertion: string | undefined,
    ): Promise<ApiResult<readonly WorkbenchTaskSummary[]>> => {
      const result = await call(assertion, 'GET', '/v1/workbench/tasks', workbenchTaskListSchema);
      return result.ok ? { ok: true, value: result.value.tasks } : result;
    },
    detail: (assertion: string | undefined, id: string): Promise<ApiResult<WorkbenchTaskDetail>> =>
      call(assertion, 'GET', task(id), workbenchTaskDetailSchema),
    create: (assertion: string | undefined, input: WorkbenchCreate) =>
      post(assertion, '/v1/workbench/tasks', input),
    command: (
      assertion: string | undefined,
      id: string,
      command: 'cancel' | 'retry' | 'reconcile',
    ) => post(assertion, `${task(id)}/${command}`, {}),
    decide: (assertion: string | undefined, id: string, decision: WorkbenchDecision) =>
      post(assertion, `${task(id)}/approval`, decision),
    source: (assertion: string | undefined, id: string): Promise<ApiResult<FixtureSource>> =>
      call(assertion, 'GET', `/v1/workbench/fixture/drive/${encodeURIComponent(id)}`, sourceSchema),
    document: (assertion: string | undefined, id: string): Promise<ApiResult<FixtureDocument>> =>
      call(assertion, 'GET', `/v1/workbench/fixture/docs/${encodeURIComponent(id)}`, docSchema),
  };
}

export type WorkbenchApi = ReturnType<typeof createWorkbenchApi>;
