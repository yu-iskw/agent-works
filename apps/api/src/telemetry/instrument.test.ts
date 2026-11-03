import { describe, expect, it, vi } from 'vitest';

import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createTaskRoutes } from '../routes/tasks.js';
import { createSkillRegistry } from '../skills/registry.js';
import { createSuspensionEnforcer, InvocationStopped } from '../suspension/enforcement.js';
import {
  publishPins,
  scopeTargets,
  suspendCommand,
  testAt,
  testContext,
} from '../suspension/test-fixtures.js';
import { taskAuthorization } from '../testing/task-authorization.js';

import { correlation, UNKNOWN_CORRELATION } from './correlation.js';
import { createJsonLinesSink, createTelemetry, METRIC_LABEL_VALUES } from './instrument.js';

import type { LogRecord, SpanRecord, TelemetrySink } from './instrument.js';
import type { Caller } from '../auth/iap.js';

const fixtures = {
  jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl',
  bearer: 'Bearer abcdef0123456789secret',
  prompt: 'PROMPT-CANARY summarize the confidential merger',
  source: 'SOURCE-BODY-CANARY quarterly revenue is 42',
  toolArg: 'TOOL-ARG-CANARY-4111111111111111',
  apiKey: 'sk-live_0123456789abcdefCANARY',
};

function memorySink() {
  const spans: SpanRecord[] = [];
  const logs: LogRecord[] = [];
  const metrics: { name: string; labels: Record<string, string> }[] = [];
  const sink: TelemetrySink = {
    span: (record) => void spans.push(record),
    log: (record) => void logs.push(record),
    metric: (name, labels) => void metrics.push({ name, labels: { ...labels } }),
  };
  return { sink, spans, logs, metrics };
}

const throwingSink: TelemetrySink = {
  span: () => {
    throw new Error('exporter down');
  },
  log: () => {
    throw new Error('exporter down');
  },
  metric: () => {
    throw new Error('exporter down');
  },
};

describe('correlation schema', () => {
  it('records unknown ids explicitly instead of dropping them', () => {
    const value = correlation({ task: 'task-1', bot: '' });
    expect(value.task).toBe('task-1');
    expect(value.bot).toBe(UNKNOWN_CORRELATION);
    expect(Object.keys(value).sort()).toEqual(
      [
        'request',
        'scheduleOccurrence',
        'task',
        'graphRevision',
        'graphNode',
        'bot',
        'grant',
        'attempt',
        'model',
        'effect',
      ].sort(),
    );
  });

  it('keeps known ids when a nested span learns more', async () => {
    const { sink, spans } = memorySink();
    const telemetry = createTelemetry(sink);
    const runInner = () =>
      telemetry.span('inner', { correlation: { effect: 'e1' } }, () => Promise.resolve());
    await telemetry.span('outer', { correlation: { task: 't1' } }, runInner);
    const inner = spans.find((span) => span.name === 'inner');
    expect(inner?.correlation).toMatchObject({ task: 't1', effect: 'e1', grant: 'unknown' });
  });
});

describe('redaction of emitted logs and spans', () => {
  it('never emits token, prompt, source or tool argument values', async () => {
    const lines: string[] = [];
    const telemetry = createTelemetry(createJsonLinesSink((line) => lines.push(line)));
    await telemetry.span('effect', { correlation: { task: 't1' } }, (span) => {
      span.attribute('authorization', fixtures.bearer);
      span.attribute('prompt', fixtures.prompt);
      span.attribute('sourceBody', fixtures.source);
      span.attribute('toolArgs', { query: fixtures.toolArg });
      span.attribute('note', `retry with ${fixtures.jwt} and ${fixtures.apiKey}`);
      return Promise.resolve();
    });
    telemetry.log('warn', 'denied', {
      assertion: fixtures.jwt,
      detail: { nested: { prompt: fixtures.prompt } },
      error: new Error(fixtures.source),
    });
    const output = lines.join('\n');
    for (const value of Object.values(fixtures)) expect(output).not.toContain(value);
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('"task":"t1"');
  });
});

describe('metric cardinality', () => {
  it('emits only the bounded label set, however many distinct ids flow through', async () => {
    const { sink, metrics } = memorySink();
    const telemetry = createTelemetry(sink);
    for (let index = 0; index < 50; index += 1) {
      await telemetry.span(
        'task.read',
        {
          correlation: { task: `task-${index}`, request: `req-${index}` },
          metric: {
            name: 'm',
            labels: { route: `task-${index}`, kind: `user-${index}` },
          },
        },
        () => Promise.resolve(),
      );
    }
    expect(metrics).toHaveLength(50);
    const allowedKeys = new Set(Object.keys(METRIC_LABEL_VALUES));
    const distinct = new Set(metrics.map((metric) => JSON.stringify(metric.labels)));
    for (const { labels } of metrics) {
      for (const [key, value] of Object.entries(labels)) {
        expect(allowedKeys.has(key)).toBe(true);
        expect(METRIC_LABEL_VALUES[key as keyof typeof METRIC_LABEL_VALUES]).toContain(value);
      }
    }
    expect(distinct.size).toBe(1);
  });
});

const submit = {
  kind: 'submit',
  objective: 'Analyze incident',
  skillId: 'incident-analysis',
  input: { incidentId: 'inc-1' },
  sourceAllowlist: ['incidents'],
  requestedOutputs: ['ticket'],
  executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 30 },
};
const submitRequest = {
  method: 'POST',
  path: '/v1/tasks',
  headers: { 'idempotency-key': 'key' },
  body: Buffer.from(JSON.stringify(submit)),
};
const verify = () => Promise.resolve({ sub: 'alice', assertion: fixtures.jwt } as Caller);

function taskRoutes(sink: TelemetrySink, base = taskAuthorization) {
  const authorization = { ...base, telemetry: createTelemetry(sink) };
  const ports = createMemoryTaskPorts();
  const skills = createSkillRegistry([
    {
      manifest: { id: submit.skillId, version: '1', state: 'PUBLISHED', tools: ['ticket.create'] },
      validate: () => true,
      dispatch: vi.fn(),
    },
  ]);
  return createTaskRoutes(ports.ledger, verify, skills, authorization, ports.dispatch);
}

describe('trace links task to policy and effect decisions', () => {
  it('joins the submit span, its policy decision and a later suspension decision by task id', async () => {
    const { sink, spans } = memorySink();
    const telemetry = createTelemetry(sink);
    const routes = taskRoutes(sink);
    const reply = await routes.submit({
      ...submitRequest,
      headers: {
        ...submitRequest.headers,
        traceparent: '00-00112233445546778899aabbccddeeff-aabbccddeeff0011-01',
      },
    });
    const { taskId } = reply.body as { taskId: string };
    const route = spans.find((span) => span.name === 'task.submit');
    const policy = spans.find((span) => span.name === 'policy.decision');
    expect(route?.correlation.task).toBe(taskId);
    expect(route?.traceId).toBe('00112233445546778899aabbccddeeff');
    expect(policy).toMatchObject({
      parentSpanId: route?.spanId,
      traceId: route?.traceId,
      attributes: { effect: 'allow' },
    });

    const ledger = createMemorySuspensionLedger();
    await publishPins(ledger);
    const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt, telemetry });
    await ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt);
    await expect(enforcer.check({ ...testContext, taskId }, 'tool')).rejects.toBeInstanceOf(
      InvocationStopped,
    );
    const decision = spans.find((span) => span.name === 'suspension.decision');
    expect(decision).toMatchObject({
      status: 'denied',
      attributes: { decision: 'INVOCATION_SUSPENDED' },
    });
    expect(decision?.correlation.task).toBe(taskId);
    expect(decision?.correlation.effect).toBe(UNKNOWN_CORRELATION);
  });

  it('records a denied policy decision as denied and returns 403', async () => {
    const { sink, spans } = memorySink();
    const routes = taskRoutes(sink, {
      ...taskAuthorization,
      wire: { ...taskAuthorization.wire, groups: () => Promise.reject(new Error('down')) },
    });
    const reply = await routes.submit(submitRequest);
    expect(reply.status).toBe(403);
    expect(spans.find((span) => span.name === 'policy.decision')?.status).toBe('denied');
    expect(spans.find((span) => span.name === 'task.submit')?.attributes).toMatchObject({
      http_status: 403,
    });
  });

  it('keeps the task id out of metric labels and the bearer assertion out of spans', async () => {
    const { sink, spans, metrics, logs } = memorySink();
    const routes = taskRoutes(sink);
    const reply = await routes.submit(submitRequest);
    const { taskId } = reply.body as { taskId: string };
    await routes.read({
      method: 'GET',
      path: `/v1/tasks/${taskId}`,
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(JSON.stringify(metrics)).not.toContain(taskId);
    expect(JSON.stringify([spans, logs, metrics])).not.toContain(fixtures.jwt);
  });
});

describe('instrumentation failure is not an authorization or effect input', () => {
  it('still denies a suspended invocation and still allows a clear one when the exporter throws', async () => {
    const ledger = createMemorySuspensionLedger();
    await publishPins(ledger);
    const enforcer = createSuspensionEnforcer({
      ledger,
      now: () => testAt,
      telemetry: createTelemetry(throwingSink),
    });
    await expect(enforcer.check(testContext, 'model')).resolves.toBeUndefined();
    await ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt);
    await expect(enforcer.check(testContext, 'model')).rejects.toMatchObject({
      code: 'INVOCATION_SUSPENDED',
    });
    expect(
      (await ledger.history()).filter((e) => e.eventType === 'invocation.denied'),
    ).toHaveLength(1);
  });

  it('keeps a denied task submit denied when the exporter throws', async () => {
    const routes = taskRoutes(throwingSink, {
      ...taskAuthorization,
      wire: { ...taskAuthorization.wire, groups: () => Promise.reject(new Error('down')) },
    });
    expect((await routes.submit(submitRequest)).status).toBe(403);
  });

  it('never reports a failed effect as successful, with or without a working exporter', async () => {
    const { sink, spans } = memorySink();
    const failure = new Error('provider refused');
    const effect = () => Promise.reject(failure);
    await expect(
      createTelemetry(sink).span('effect', { correlation: { effect: 'e1' } }, effect),
    ).rejects.toBe(failure);
    expect(spans.map((span) => span.status)).toEqual(['error']);
    await expect(createTelemetry(throwingSink).span('effect', {}, effect)).rejects.toBe(failure);
    await expect(
      createTelemetry(throwingSink).span('effect', {}, () => Promise.resolve('receipt-1')),
    ).resolves.toBe('receipt-1');
  });
});
