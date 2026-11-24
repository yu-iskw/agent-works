import { createAdkRunner, FetchLlm } from '@agent-works/agent-runtime';
import { askRequestSchema, IAP_ASSERTION_HEADER, runnerLimitsSchema } from '@agent-works/domain';
import { decide as decidePolicy } from '@agent-works/policy';

import { ask } from '../application/ask/ask-use-case.js';
import { AuditWriteError } from '../audit/write.js';
import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { readRunnerKind } from '../config.js';
import { headerValue } from '../http.js';
import { beforeModelCall } from '../suspension/runtime.js';

import type { AskResult } from '../application/ask/ask-use-case.js';
import type { AskRunner, AskWire } from '../application/ask/ports.js';
import type { AuditLog } from '../audit/write.js';
import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { Drive } from '../retrieval/drive-port.js';
import type { AgentRunner } from '@agent-works/agent-runtime/port';

export type AskDeps = {
  readonly verify: VerifyAssertion;
  readonly drive: Drive;
  readonly runner: AgentRunner;
  readonly audit: AuditLog;
  readonly now: () => Date;
  readonly wire?: AskWire;
};

const askLimits = runnerLimitsSchema.parse({
  maxSteps: 4,
  maxToolCalls: 4,
  maxCostUsd: 1,
  maxElapsedMs: 30_000,
  maxBytesRetrieved: 1_000_000,
  maxGeneratedOutputs: 1,
  maxModelRetries: 1,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
});

const noSourcesAnswer = 'I could not find a source for that.';

export function createAskRoute(deps: AskDeps): Route {
  return async (request) => {
    const authenticated = await authenticate(
      deps.verify,
      headerValue(request.headers, IAP_ASSERTION_HEADER),
    );
    if (authenticated.ok === false) return authenticated.reply;
    const parsed = askRequestSchema.safeParse(parseJson(request.body));
    if (!parsed.success) return { status: 400, body: { error: 'invalid_request' } };
    try {
      const result = await ask(
        {
          ...resolveRunner(deps.runner),
          retrieval: deps.drive,
          audit: deps.audit,
          policy: decidePolicy,
          clock: deps.now,
          wire: deps.wire,
        },
        authenticated.caller,
        parsed.data,
      );
      return replyFor(result, parsed.data.requestId);
    } catch (error) {
      if (error instanceof AuditWriteError) return { status: 503, body: { error: 'audit_failed' } };
      throw error;
    }
  };
}

type AuthResult =
  { readonly ok: true; readonly caller: Caller } | { readonly ok: false; readonly reply: ApiReply };

async function authenticate(
  verify: VerifyAssertion,
  assertion: string | undefined,
): Promise<AuthResult> {
  try {
    return { ok: true, caller: await verify(assertion) };
  } catch (error) {
    if (error instanceof Unauthenticated) {
      return { ok: false, reply: { status: 401, body: { error: 'unauthenticated' } } };
    }
    if (error instanceof Unavailable) {
      return { ok: false, reply: { status: 503, body: { error: 'unavailable' } } };
    }
    throw error;
  }
}

function replyFor(result: AskResult, requestId: string): ApiReply {
  switch (result.kind) {
    case 'answered':
      return {
        status: 200,
        body: { requestId, answer: result.answer, citations: result.citations },
      };
    case 'no_sources':
      return { status: 200, body: { requestId, answer: noSourcesAnswer, citations: [] } };
    case 'denied':
      return { status: 403, body: { error: 'denied' } };
    case 'retrieval_failed':
      return { status: 502, body: { error: 'retrieval_failed' } };
    case 'runner_failed':
      return { status: 502, body: { error: 'runner_failed' } };
    case 'conflict':
      return { status: 409, body: { error: 'conflict' } };
    default: {
      const unexpected: never = result;
      return unexpected;
    }
  }
}

function resolveRunner(fallback: AgentRunner): AskRunner {
  const baseUrl = process.env.LLM_URL;
  if (readRunnerKind(process.env) === 'adk' && baseUrl !== undefined && baseUrl.trim().length > 0) {
    return {
      runner: createAdkRunner({
        model: new FetchLlm({ baseUrl }),
        limits: askLimits,
        beforeModelCall,
      }),
      agentPrincipal: 'agent:adk-runner',
    };
  }
  return { runner: fallback, agentPrincipal: 'agent:scripted-runner' };
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
