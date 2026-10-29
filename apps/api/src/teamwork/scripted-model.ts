import type { GenerateRequest, GenerateResult, ModelPort } from '../workbench/model-port.js';

/**
 * Deterministic model for UI review rounds only (LLM_MODE=scripted). It answers in the same JSON
 * contracts by quoting the evidence it was given, so pages render realistic content. The runtime
 * refuses it outside the local-test identity with fixture sources, it is labelled on every page,
 * and its ledger rows have mode `stub`, so it can never count as, or spend, a real model call.
 */
const SCRIPTED_MODEL_ID = 'scripted-ui-review';

type Evidence = { readonly id: string; readonly title: string; readonly lines: readonly string[] };

function evidenceIn(prompt: string): Evidence[] {
  const out: Evidence[] = [];
  // Prompts are built by this service from gate-bounded text, never from a request body.
  for (const match of prompt.matchAll(
    // eslint-disable-next-line security/detect-unsafe-regex
    /^(E\d+)\ntitle: ("[^\n]*")\n[\s\S]*?content: ([^\n]*(?:\n(?!E\d+\n)[^\n]*)*)/gm,
  )) {
    let text = match.at(3) ?? '';
    try {
      const parsed: unknown = JSON.parse(text.slice(text.indexOf('{')));
      if (typeof parsed === 'object' && parsed !== null && 'text' in parsed)
        text = String(parsed.text);
    } catch {
      // The envelope shape is owned by governance/source-data; fall back to the raw text.
    }
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^[-#\s]+/, '').trim())
      .filter(
        (line) =>
          line.length > 30 &&
          !/IGNORE|OVERRIDE|canary|^AW-M1|^(Last reviewed|Meeting date|Date|Dates):/i.test(line),
      );
    out.push({ id: match.at(1) ?? 'E1', title: JSON.parse(match.at(2) ?? '""') as string, lines });
  }
  return out;
}

function calculationsIn(prompt: string): readonly { id: string; line: string }[] {
  return [...prompt.matchAll(/^(C\d+): (.*)$/gm)].map((m) => ({
    id: m.at(1) ?? 'C1',
    line: m.at(2) ?? '',
  }));
}

function facts(evidence: readonly Evidence[], take: number) {
  return evidence.flatMap((item) =>
    item.lines
      .slice(0, take)
      .map((line) => ({ kind: 'fact', text: line, evidenceIds: [item.id], calculationIds: [] })),
  );
}

function calcStatements(prompt: string) {
  return calculationsIn(prompt)
    .slice(0, 4)
    .map((calc) => {
      // eslint-disable-next-line security/detect-unsafe-regex
      const values = /= ([\d.-]+), \S+ = ([\d.-]+), change ([\d.-]+)(?: \(([\d.-]+)%\))?/.exec(
        calc.line,
      );
      const label = calc.line.split(':')[0] ?? calc.id;
      const text =
        values === null
          ? label
          : `${label} moved from ${values[1]} to ${values[2]} (${values.at(4) ?? values.at(3)}${values.at(4) === undefined ? '' : '%'}).`;
      return { kind: 'calculation', text, evidenceIds: [], calculationIds: [calc.id] };
    });
}

type Statement = {
  readonly kind: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly calculationIds: readonly string[];
};

function planResponse(prompt: string): unknown {
  const roster = JSON.parse(/Roster: (\[.*\])/.exec(prompt)?.at(1) ?? '[]') as {
    id: string;
    name: string;
    capabilities: string[];
  }[];
  const sources = /Allowed sources: (.*)/.exec(prompt)?.at(1)?.split(', ') ?? [];
  const has = (r: (typeof roster)[number], capability: string) =>
    r.capabilities.includes(capability);
  // Pick specialists the way a coordinator would for each workflow's sources.
  const fit = sources.includes('bigquery_metrics')
    ? [
        roster.find((r) => has(r, 'bigquery.query')),
        roster.find((r) => /context/i.test(r.name)),
      ].filter((r) => r !== undefined)
    : sources.some((source) => source.startsWith('github'))
      ? roster.filter((r) => has(r, 'github.read')).slice(0, 2)
      : roster.filter((r) => has(r, 'drive.read') && !/context/i.test(r.name)).slice(0, 2);
  return {
    summary: `Two specialists work in parallel, then the coordinator combines their findings.`,
    assignments: fit.map((r, index) => ({
      key: index === 0 ? 'primary-evidence' : 'risks-and-conflicts',
      teammateId: r.id,
      brief:
        index === 0
          ? 'Collect the main facts for each option with source dates.'
          : 'Find conflicting figures, stale sources and open questions.',
      deliverable: 'Cited findings',
      sources,
      dependsOn: [],
    })),
    expectedEffects: [],
  };
}

/** The non-fact statements a section heading calls for, so every section type gets exercised. */
function sectionExtras(
  heading: string,
  revised: boolean,
  evidence: readonly Evidence[],
): Statement[] {
  const lower = heading.toLowerCase();
  const extras: Statement[] = [];
  if (lower.includes('question') || lower.includes('decision'))
    extras.push({
      kind: 'question',
      text: 'Which of the two conflicting figures is contractually binding?',
      evidenceIds: [],
      calculationIds: [],
    });
  if (lower.includes('cause'))
    extras.push({
      kind: 'hypothesis',
      text: 'A launch in the same window may explain part of the change.',
      evidenceIds: [],
      calculationIds: [],
    });
  if (lower.includes('conclusion'))
    extras.push({
      kind: 'recommendation',
      text: `Prefer the option that meets the stated requirement${revised ? ', pending the open question' : ''}.`,
      evidenceIds: evidence.slice(0, 1).map((e) => e.id),
      calculationIds: [],
    });
  return extras;
}

function artifactResponse(request: GenerateRequest, evidence: readonly Evidence[]): unknown {
  const headings = [
    ...(
      /exactly these section headings, in this order: (.*)\./.exec(request.system)?.at(1) ??
      '"Findings"'
    ).matchAll(/"([^"]+)"/g),
  ].map((m) => m.at(1) ?? 'Findings');
  const revised = request.prompt.includes('Member revision request');
  const pool = [...calcStatements(request.prompt), ...facts(evidence, 2)];
  const title = headings.includes('Metric definitions')
    ? 'Metrics explanation'
    : headings.includes('Scope')
      ? 'Implementation proposal'
      : 'Decision brief';
  return {
    title: `${title}${revised ? ' (revised)' : ''}`,
    summary: revised
      ? 'Revised as requested: conflicting figures stay unresolved and the open questions list them.'
      : 'The sources support a clear front-runner, with one conflicting figure still open.',
    sections: headings.map((heading, index) => ({
      heading,
      statements: [
        ...pool.slice(index * 2, index * 2 + 2),
        ...sectionExtras(heading, revised, evidence),
      ],
    })),
    limitations: revised ? ['Figures from the stale source were not used as current values.'] : [],
  };
}

function respond(request: GenerateRequest): unknown {
  const schema = JSON.stringify(request.jsonSchema ?? {});
  const evidence = evidenceIn(request.prompt);
  if (schema.includes('"expectedEffects"')) return planResponse(request.prompt);
  if (schema.includes('"limitations"')) return artifactResponse(request, evidence);
  if (schema.includes('"gaps"'))
    return {
      summary: `Reviewed ${evidence.length} sources and extracted the facts that bear on the question.`,
      statements: [...calcStatements(request.prompt), ...facts(evidence, 1)].slice(0, 8),
      gaps: ['No source states the contractual terms.'],
      question: '',
    };
  return 'Scripted reply for UI review. Start a task with me when the work needs documents, metrics or code.';
}

export function createScriptedModel(): ModelPort {
  return {
    mode: 'stub',
    modelId: SCRIPTED_MODEL_ID,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const body = respond(request);
      // A short pause so review rounds can see the running and planning states at all.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return {
        text: typeof body === 'string' ? body : JSON.stringify(body),
        modelVersion: SCRIPTED_MODEL_ID,
        latencyMs: 3000,
      };
    },
  };
}
