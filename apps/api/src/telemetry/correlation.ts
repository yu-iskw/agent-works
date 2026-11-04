const CORRELATION_KEYS = [
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
] as const;
type CorrelationKey = (typeof CORRELATION_KEYS)[number];
export type Correlation = Readonly<Record<CorrelationKey, string>>;
export type CorrelationInput = Partial<Record<CorrelationKey, string | null | undefined>>;

/** A correlation id that is not known yet is recorded as this value, never omitted. */
export const UNKNOWN_CORRELATION = 'unknown';

export function correlation(input: CorrelationInput = {}): Correlation {
  return Object.freeze(
    Object.fromEntries(
      // eslint-disable-next-line security/detect-object-injection -- key comes from a closed union
      CORRELATION_KEYS.map((key) => [key, input[key] ? input[key] : UNKNOWN_CORRELATION]),
    ),
  ) as Correlation;
}

export function mergeCorrelation(base: Correlation, extra: CorrelationInput): Correlation {
  const known = Object.entries(base).filter(([, id]) => id !== UNKNOWN_CORRELATION);
  return correlation({ ...Object.fromEntries(known), ...definedOnly(extra) });
}

function definedOnly(input: CorrelationInput): CorrelationInput {
  return Object.fromEntries(Object.entries(input).filter(([, id]) => Boolean(id)));
}
