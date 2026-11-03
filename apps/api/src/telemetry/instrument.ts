import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { correlation, mergeCorrelation } from './correlation.js';
import { redact } from './redaction.js';
import { continuePropagated } from './trace.js';

import type { Correlation, CorrelationInput } from './correlation.js';

type SpanStatus = 'ok' | 'denied' | 'error';
export type SpanRecord = {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly correlation: Correlation;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
};
export type LogRecord = {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly traceId: string | null;
  readonly correlation: Correlation;
  readonly attributes: Readonly<Record<string, unknown>>;
};

/** Metric labels are a closed set. Ids belong in spans and logs, never here. */
export const METRIC_LABEL_VALUES = {
  route: [
    'task.submit',
    'task.read',
    'task.events',
    'task.cancel',
    'owner.read',
    'suspension.check',
    'effect',
    'other',
  ],
  outcome: ['ok', 'denied', 'error', 'other'],
  kind: ['model', 'tool', 'admission', 'other'],
} as const satisfies Record<string, readonly string[]>;
type MetricLabels = { [K in keyof typeof METRIC_LABEL_VALUES]?: string };
export type TelemetrySink = {
  span(record: SpanRecord): void;
  log(record: LogRecord): void;
  metric(name: string, labels: Readonly<Record<string, string>>): void;
};
type ActiveSpan = {
  readonly traceId: string;
  readonly spanId: string;
  correlate(extra: CorrelationInput): void;
  attribute(key: string, value: unknown): void;
  status(status: SpanStatus): void;
};
type SpanOptions = {
  readonly correlation?: CorrelationInput;
  readonly traceparent?: string;
  readonly metric?: { readonly name: string; readonly labels: MetricLabels };
};
export type Telemetry = {
  span<T>(name: string, options: SpanOptions, run: (span: ActiveSpan) => Promise<T>): Promise<T>;
  log(level: LogRecord['level'], message: string, attributes?: Record<string, unknown>): void;
};

export const noopTelemetry: Telemetry = {
  span: (_name, _options, run) =>
    run({
      traceId: '',
      spanId: '',
      correlate() {},
      attribute() {},
      status() {},
    }),
  log() {},
};

type Scope = { traceId: string; spanId: string; correlation: Correlation };

/**
 * Observation never changes the observed outcome: the wrapped work runs first, its result or
 * error is returned untouched, and every sink failure is swallowed.
 */
export function createTelemetry(sink: TelemetrySink): Telemetry {
  const scopes = new AsyncLocalStorage<Scope>();
  const safe = (emit: () => void): void => {
    try {
      emit();
    } catch {
      /* A broken exporter must not alter authorization or effect outcomes. */
    }
  };
  return {
    async span(name, options, run) {
      const parent = scopes.getStore();
      const remote = parent === undefined ? remoteParent(options.traceparent) : undefined;
      const scope: Scope = {
        traceId: parent?.traceId ?? remote?.traceId ?? randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        correlation: mergeCorrelation(
          parent?.correlation ?? correlation(),
          options.correlation ?? {},
        ),
      };
      const attributes: Record<string, unknown> = {};
      let status: SpanStatus | undefined;
      const active: ActiveSpan = {
        traceId: scope.traceId,
        spanId: scope.spanId,
        correlate(extra) {
          scope.correlation = mergeCorrelation(scope.correlation, extra);
        },
        attribute(key, value) {
          // eslint-disable-next-line security/detect-object-injection -- key comes from a closed union
          attributes[key] = value;
        },
        status(next) {
          status = next;
        },
      };
      let failed = false;
      try {
        return await scopes.run(scope, () => run(active));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const final: SpanStatus = status ?? (failed ? 'error' : 'ok');
        safe(() => {
          sink.span({
            name,
            traceId: scope.traceId,
            spanId: scope.spanId,
            parentSpanId: parent?.spanId ?? remote?.spanId ?? null,
            correlation: scope.correlation,
            status: final,
            attributes: redact(attributes) as Record<string, unknown>,
          });
        });
        if (options.metric !== undefined) {
          const { name: metricName, labels } = options.metric;
          safe(() => {
            sink.metric(metricName, boundedLabels({ outcome: final, ...labels }));
          });
        }
      }
    },
    log(level, message, attributes = {}) {
      const scope = scopes.getStore();
      safe(() => {
        sink.log({
          level,
          message,
          traceId: scope?.traceId ?? null,
          correlation: scope?.correlation ?? correlation(),
          attributes: redact(attributes) as Record<string, unknown>,
        });
      });
    },
  };
}

/** One JSON line per record, already redacted by the telemetry core. */
export function createJsonLinesSink(write: (line: string) => void): TelemetrySink {
  return {
    span: (record) => write(JSON.stringify({ type: 'span', ...record })),
    log: (record) => write(JSON.stringify({ type: 'log', ...record })),
    metric: (name, labels) => write(JSON.stringify({ type: 'metric', name, labels })),
  };
}

function boundedLabels(labels: MetricLabels): Record<string, string> {
  return Object.fromEntries(
    Object.entries(METRIC_LABEL_VALUES).flatMap(([key, allowed]) => {
      const value = labels[key as keyof MetricLabels];
      if (value === undefined) return [];
      return [[key, (allowed as readonly string[]).includes(value) ? value : 'other']];
    }),
  );
}

function remoteParent(header: string | undefined): { traceId: string; spanId: string } | undefined {
  const web = header === undefined ? undefined : continuePropagated(header)?.[0];
  return web === undefined ? undefined : { traceId: web.traceId, spanId: web.spanId };
}
