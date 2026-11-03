import * as z from 'zod';

/** Provisional P08 target from ACCEPTANCE.md. Not an approved SLO. */
export const P08_PROVISIONAL_ATTRIBUTION = 0.99;

const lineSchema = z.strictObject({
  lineId: z.string().min(1),
  amountMicros: z.number().int().nonnegative().safe(),
  executionId: z.string().min(1).nullable(),
  segmentId: z.string().min(1).nullable(),
  service: z.string().nullable(),
});
export type BillingLine = z.infer<typeof lineSchema>;

export type LedgerOwner = {
  readonly memberId: string;
  readonly botId: string;
  readonly segmentId: string;
};
export type AttributedLine = {
  readonly line: BillingLine;
  readonly kind: 'execution' | 'team' | 'unassigned';
  readonly reason?: 'no_label' | 'unknown_execution';
  readonly owner: LedgerOwner | null;
  readonly segmentId: string | null;
};

function blankToNull(value: unknown): unknown {
  return value === undefined || value === '' ? null : value;
}

function normalize(raw: Record<string, unknown>): BillingLine {
  const amount = raw.amountMicros ?? raw.amount_micros;
  return lineSchema.parse({
    lineId: raw.lineId ?? raw.line_id,
    amountMicros: typeof amount === 'string' ? Number(amount) : amount,
    executionId: blankToNull(raw.executionId ?? raw.execution_id),
    segmentId: blankToNull(raw.segmentId ?? raw.segment_id),
    service: blankToNull(raw.service),
  });
}

function assertUnique(lines: readonly BillingLine[]): readonly BillingLine[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.lineId)) throw new Error('duplicate billing line');
    seen.add(line.lineId);
  }
  return lines;
}

/** JSON: an array, or {lines: [...]}. Keys are camelCase or snake_case. */
export function parseBillingJson(text: string): readonly BillingLine[] {
  const value = JSON.parse(text) as unknown;
  const rows = Array.isArray(value) ? value : (value as { lines?: unknown }).lines;
  if (!Array.isArray(rows)) throw new Error('billing export must be an array or {lines}');
  return assertUnique(rows.map((row) => normalize(row as Record<string, unknown>)));
}

/** CSV: header line_id,amount_micros,execution_id,segment_id,service. No quoting or embedded commas. */
export function parseBillingCsv(text: string): readonly BillingLine[] {
  const all = text.split(/\r?\n/).filter((row) => row.trim() !== '');
  if (all.length === 0) throw new Error('empty billing export');
  const [header, ...rows] = all;
  const names = header.split(',').map((name) => name.trim());
  for (const required of ['line_id', 'amount_micros'])
    if (!names.includes(required)) throw new Error(`missing column ${required}`);
  return assertUnique(
    rows.map((row) => {
      const cells = row.split(',');
      if (cells.length !== names.length) throw new Error('billing row width mismatch');
      // eslint-disable-next-line security/detect-object-injection -- index is bounded by names.length
      return normalize(Object.fromEntries(names.map((name, i) => [name, cells[i].trim()])));
    }),
  );
}

export function parseBillingExport(text: string, format: 'csv' | 'json'): readonly BillingLine[] {
  return format === 'csv' ? parseBillingCsv(text) : parseBillingJson(text);
}

/** Resolves each line against the execution ledger. Every line lands in exactly one bucket. */
export function attributeLines(
  lines: readonly BillingLine[],
  ledger: ReadonlyMap<string, LedgerOwner>,
): readonly AttributedLine[] {
  return lines.map((line): AttributedLine => {
    const owner = line.executionId === null ? undefined : ledger.get(line.executionId);
    if (owner !== undefined) return { line, kind: 'execution', owner, segmentId: owner.segmentId };
    if (line.segmentId !== null)
      return { line, kind: 'team', owner: null, segmentId: line.segmentId };
    return {
      line,
      kind: 'unassigned',
      reason: line.executionId === null ? 'no_label' : 'unknown_execution',
      owner: null,
      segmentId: null,
    };
  });
}

export type BillingAttribution = {
  readonly lines: number;
  readonly totalMicros: number;
  readonly attributedMicros: number;
  readonly unassignedMicros: number;
  readonly unassignedLineIds: readonly string[];
  /** null when the export is empty. */
  readonly attributionRatio: number | null;
  readonly meetsProvisionalTarget: boolean | null;
};

export function summarizeAttribution(attributed: readonly AttributedLine[]): BillingAttribution {
  let total = 0;
  let unassigned = 0;
  const ids: string[] = [];
  for (const row of attributed) {
    total += row.line.amountMicros;
    if (row.kind === 'unassigned') {
      unassigned += row.line.amountMicros;
      ids.push(row.line.lineId);
    }
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('billing overflow');
  const ratio = total === 0 ? null : (total - unassigned) / total;
  return {
    lines: attributed.length,
    totalMicros: total,
    attributedMicros: total - unassigned,
    unassignedMicros: unassigned,
    unassignedLineIds: ids,
    attributionRatio: ratio,
    meetsProvisionalTarget: ratio === null ? null : ratio >= P08_PROVISIONAL_ATTRIBUTION,
  };
}
