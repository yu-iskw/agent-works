import { randomBytes } from 'node:crypto';

export type TraceSpan = {
  readonly name: 'web' | 'api' | 'runner' | 'retrieval';
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
};

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

export function continuePropagated(
  header: string,
  entropyHex?: string,
): readonly TraceSpan[] | undefined {
  const root = parseTraceparent(header);
  if (root === undefined) return undefined;
  const spanIds = readSpanIds(entropyHex);
  if (spanIds === undefined) return undefined;
  const web: TraceSpan = {
    name: 'web',
    traceId: root.traceId,
    spanId: root.spanId,
    parentSpanId: null,
  };
  const api = childSpan('api', web, spanIds[0]);
  return [web, api, childSpan('runner', api, spanIds[1]), childSpan('retrieval', api, spanIds[2])];
}

export function toOtlpJsonLines(spans: readonly TraceSpan[]): string {
  return `${spans.map((span) => JSON.stringify(otlpLine(span))).join('\n')}\n`;
}

function childSpan(
  name: 'api' | 'runner' | 'retrieval',
  parent: TraceSpan,
  spanId: string,
): TraceSpan {
  return {
    name,
    traceId: parent.traceId,
    spanId,
    parentSpanId: parent.spanId,
  };
}

function parseTraceparent(
  header: string,
): { readonly traceId: string; readonly spanId: string } | undefined {
  const match = traceparentPattern.exec(header);
  if (match === null) return undefined;
  const traceId = match[1];
  const spanId = match[2];
  if (isZero(traceId) || isZero(spanId)) return undefined;
  return { traceId, spanId };
}

function readSpanIds(
  entropyHex: string | undefined,
): readonly [string, string, string] | undefined {
  if (entropyHex === undefined) return [freshSpanId(), freshSpanId(), freshSpanId()];
  if (!/^[0-9a-f]{48}$/.test(entropyHex)) return undefined;
  const spanIds = [
    entropyHex.slice(0, 16),
    entropyHex.slice(16, 32),
    entropyHex.slice(32, 48),
  ] as const;
  if (spanIds.some((spanId) => isZero(spanId))) return undefined;
  return spanIds;
}

function freshSpanId(): string {
  return randomBytes(8).toString('hex');
}

function isZero(hex: string): boolean {
  return /^0+$/.test(hex);
}

function otlpLine(span: TraceSpan) {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: span.name,
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId ?? '',
              },
            ],
          },
        ],
      },
    ],
  };
}
