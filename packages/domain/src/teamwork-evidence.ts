import { MATERIAL_KINDS } from './teamwork.js';

import type { ArtifactContent, Calculation, RevisionDiff, Statement } from './teamwork.js';

/** Declared numeric tolerances for model prose checked against deterministic calculations. */
const NUMERIC_TOLERANCE = { relative: 0.005, absolute: 0.01, percentPoints: 0.1 } as const;

export type SupportSource = {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
};

const STOPWORDS = new Set(
  'about above after again against also because been before being below between both could does doing during each from further have having here into itself more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your'.split(
    ' ',
  ),
);

// Fraction written as `(?:\.\d)?\d*` so no quantifier nests; the integer part already took every digit.
const numberToken = /-?\d[\d,]*(?:\.\d)?\d*%?/g;
const isoDate = /\b\d{4}-\d{2}(?:-\d\d)?\b/g;

function normalizeNumber(raw: string): number | undefined {
  const value = Number(raw.replaceAll(',', '').replace(/%$/, ''));
  return Number.isFinite(value) ? value : undefined;
}

/** Numbers that carry meaning; ordinals inside dates and single list digits are not claims. */
export function claimNumbers(text: string): readonly string[] {
  const withoutDates = text.replaceAll(isoDate, ' ');
  return [...withoutDates.matchAll(numberToken)]
    .map((match) => match[0])
    .filter((token) => !/^-?\d$/.test(token));
}

function claimDates(text: string): readonly string[] {
  return [...text.matchAll(isoDate)].map((match) => match[0]);
}

function significantWords(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
    ),
  ];
}

function sourceNumbers(text: string): readonly number[] {
  return [...text.matchAll(numberToken)]
    .map((match) => normalizeNumber(match[0]))
    .filter((value): value is number => value !== undefined);
}

function close(claimed: number, actual: number, percent: boolean): boolean {
  if (percent)
    return Math.abs(Math.abs(claimed) - Math.abs(actual)) <= NUMERIC_TOLERANCE.percentPoints;
  const delta = Math.abs(Math.abs(claimed) - Math.abs(actual));
  return (
    delta <= Math.max(NUMERIC_TOLERANCE.absolute, NUMERIC_TOLERANCE.relative * Math.abs(actual))
  );
}

function calculationNumbers(calc: Calculation): {
  readonly values: readonly number[];
  readonly pct: readonly number[];
} {
  return {
    values: [calc.baselineValue, calc.currentValue, calc.change],
    pct: calc.changePct === null ? [] : [calc.changePct],
  };
}

function cited<T>(ids: readonly string[], byId: ReadonlyMap<string, T>): readonly T[] {
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
}

function numberSupported(
  token: string,
  corpusNumbers: readonly number[],
  calcs: readonly Calculation[],
): boolean {
  const claimed = normalizeNumber(token);
  if (claimed === undefined) return true;
  const percent = token.endsWith('%');
  return (
    corpusNumbers.some((value) => close(claimed, value, percent)) ||
    calcs.some((calc) => {
      const numbers = calculationNumbers(calc);
      return (percent ? numbers.pct : numbers.values).some((value) =>
        close(claimed, value, percent),
      );
    })
  );
}

function dateSupported(date: string, corpus: string, calcs: readonly Calculation[]): boolean {
  return (
    corpus.includes(date) || calcs.some((calc) => calc.baseline === date || calc.current === date)
  );
}

function wordingMatches(text: string, corpus: string): boolean {
  const words = significantWords(text);
  const haystack = new Set(significantWords(corpus));
  const overlap = words.filter((word) => haystack.has(word)).length;
  return words.length === 0 || overlap >= Math.min(2, words.length);
}

export type SupportResult = {
  readonly support: Statement['support'];
  readonly reason: string | null;
};

const unsupported = (reason: string): SupportResult => ({ support: 'unsupported', reason });

/**
 * Deterministic support check for one statement. A material statement is supported only when
 * every number and date it states appears in a cited source or matches a cited calculation within
 * the declared tolerance, and its wording overlaps a cited passage. Citation IDs alone are not
 * enough. The check cannot prove meaning; it rejects claims that their sources cannot contain.
 */
export function checkSupport(
  statement: Pick<Statement, 'kind' | 'text' | 'evidenceIds' | 'calculationIds'>,
  sources: ReadonlyMap<string, SupportSource>,
  calculations: ReadonlyMap<string, Calculation>,
): SupportResult {
  if (!MATERIAL_KINDS.has(statement.kind)) return { support: 'not_required', reason: null };
  const citedSources = cited(statement.evidenceIds, sources);
  const calcs = cited(statement.calculationIds, calculations);
  if (citedSources.length === 0 && calcs.length === 0)
    return unsupported('No retrieved source or calculation is cited.');
  const corpus = citedSources.map((source) => `${source.title}\n${source.excerpt}`).join('\n');
  const corpusNumbers = sourceNumbers(corpus);
  const number = claimNumbers(statement.text).find(
    (token) => !numberSupported(token, corpusNumbers, calcs),
  );
  if (number !== undefined) return unsupported(`${number} does not appear in the cited sources.`);
  const date = claimDates(statement.text).find((claimed) => !dateSupported(claimed, corpus, calcs));
  if (date !== undefined) return unsupported(`${date} does not appear in the cited sources.`);
  if (citedSources.length > 0 && !wordingMatches(statement.text, corpus))
    return unsupported('The wording does not match the cited passages.');
  return { support: 'supported', reason: null };
}

function statementLines(content: ArtifactContent): ReadonlyMap<string, readonly string[]> {
  return new Map(
    content.sections.map((section) => [section.heading, section.statements.map((s) => s.text)]),
  );
}

/** A content diff a member can read: statements added or removed per section, and source changes. */
export function diffRevisions(
  previous: { readonly content: ArtifactContent; readonly sources: readonly string[] },
  next: { readonly content: ArtifactContent; readonly sources: readonly string[] },
): RevisionDiff {
  const before = statementLines(previous.content);
  const after = statementLines(next.content);
  const headings = [...new Set([...before.keys(), ...after.keys()])];
  const added: RevisionDiff['added'] = [];
  const removed: RevisionDiff['removed'] = [];
  const changedSections: string[] = [];
  for (const heading of headings) {
    const old = new Set(before.get(heading) ?? []);
    const neu = new Set(after.get(heading) ?? []);
    const plus = [...neu].filter((line) => !old.has(line));
    const minus = [...old].filter((line) => !neu.has(line));
    if (plus.length > 0 || minus.length > 0) changedSections.push(heading);
    added.push(...plus.map((line) => ({ heading, text: line })));
    removed.push(...minus.map((line) => ({ heading, text: line })));
  }
  if (previous.content.summary !== next.content.summary) {
    changedSections.unshift('Summary');
    added.unshift({ heading: 'Summary', text: next.content.summary });
    removed.unshift({ heading: 'Summary', text: previous.content.summary });
  }
  const oldSources = new Set(previous.sources);
  const newSources = new Set(next.sources);
  return {
    added,
    removed,
    changedSections,
    sourcesAdded: [...newSources].filter((source) => !oldSources.has(source)),
    sourcesRemoved: [...oldSources].filter((source) => !newSources.has(source)),
  };
}

/**
 * The returned model must be the configured one. Vertex may append a version suffix such as
 * `-001` or a release date; any other family or name is a mismatch, never a fallback.
 */
export function isRequestedModel(configured: string, returned: string): boolean {
  if (returned === configured) return true;
  if (!returned.startsWith(`${configured}-`)) return false;
  const suffix = returned.slice(configured.length + 1);
  return /^(\d{3}|\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/.test(suffix);
}

/** Missing required section headings, compared case-insensitively. */
export function missingSections(
  content: ArtifactContent,
  required: readonly string[],
): readonly string[] {
  const present = new Set(content.sections.map((section) => section.heading.trim().toLowerCase()));
  return required.filter((heading) => !present.has(heading.trim().toLowerCase()));
}

export function artifactMarkdown(
  content: ArtifactContent,
  sourceTitles: ReadonlyMap<string, string>,
): string {
  const cite = (ids: readonly string[]) =>
    ids.length === 0
      ? ''
      : ` [${ids.map((evidenceId) => sourceTitles.get(evidenceId) ?? evidenceId).join('; ')}]`;
  const lines = [`# ${content.title}`, '', content.summary, ''];
  for (const section of content.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const statement of section.statements) {
      const flag = statement.support === 'unsupported' ? ' (unverified inference)' : '';
      lines.push(`- ${statement.text}${flag}${cite(statement.evidenceIds)}`);
    }
    lines.push('');
  }
  if (content.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const limitation of content.limitations) lines.push(`- ${limitation}`);
    lines.push('');
  }
  return lines.join('\n');
}
