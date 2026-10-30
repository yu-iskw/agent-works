import { PORTABLE_FORMAT, portableDefinitionSchema } from './teamwork.js';

import type { Capability, PortableDefinition, SkillDefinition } from './teamwork.js';

export type PortableFinding = {
  readonly field: string;
  readonly kind: 'secret' | 'private_identifier' | 'email';
  readonly label: string;
};

/**
 * Known secret shapes. This is a backstop, not a guarantee: arbitrary prose can still describe
 * private facts, which is why export always shows an editable preview first.
 */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/ya29\.[\w-]{10,}/, 'Google OAuth access token'],
  [/\b1\/\/[\w-]{20,}/, 'Google OAuth refresh token'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Private key'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/, 'Signed token (JWT)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abposr]-[\w-]{10,}/, 'Slack token'],
  [/"(?:private_key|client_secret|refresh_token|access_token)"\s*:/i, 'Credential JSON field'],
  [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i, 'Credential assignment'],
];

// Dotted labels written without a nested quantifier; same language as [\w-]+(?:\.[\w-]+)+.
const EMAIL = /[\w.+-]+@[\w-]+\.(?:[\w-]|[\w-]\.)*[\w-]/;

function strings(definition: PortableDefinition): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [
    ['name', definition.name],
    ['role', definition.role],
    ['instructions', definition.instructions],
  ];
  definition.skills.forEach((skill, index) => {
    const prefix = `skills[${index}]`;
    out.push(
      [`${prefix}.name`, skill.name],
      [`${prefix}.summary`, skill.summary],
      [`${prefix}.applicability`, skill.applicability],
      [`${prefix}.missingData`, skill.missingData],
      [`${prefix}.approvalBoundary`, skill.approvalBoundary],
      ...skill.steps.map((step, i) => [`${prefix}.steps[${i}]`, step] as const),
      ...skill.validation.map((rule, i) => [`${prefix}.validation[${i}]`, rule] as const),
      ...skill.outputSections.map(
        (heading, i) => [`${prefix}.outputSections[${i}]`, heading] as const,
      ),
      ...skill.inputs.map((input, i) => [`${prefix}.inputs[${i}]`, input.description] as const),
    );
  });
  definition.parameters.forEach((parameter, index) =>
    out.push([`parameters[${index}].description`, parameter.description]),
  );
  return out;
}

/**
 * Scans every string of a definition for secret shapes, email addresses and the caller's known
 * private identifiers (connected account, allowlisted folder, dataset and resource IDs).
 */
export function inspectPortable(
  definition: PortableDefinition,
  knownPrivate: readonly string[],
): readonly PortableFinding[] {
  const privateValues = knownPrivate.filter((value) => value.length >= 6);
  const findings: PortableFinding[] = [];
  for (const [field, value] of strings(definition)) {
    for (const [pattern, label] of SECRET_PATTERNS)
      if (pattern.test(value)) findings.push({ field, kind: 'secret', label });
    if (EMAIL.test(value)) findings.push({ field, kind: 'email', label: 'Email address' });
    if (privateValues.some((secret) => value.includes(secret)))
      findings.push({
        field,
        kind: 'private_identifier',
        label: 'Private account or resource identifier',
      });
  }
  return findings;
}

export type PortableSource = {
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  readonly capabilityRequests: readonly Capability[];
  readonly skills: readonly SkillDefinition[];
};

/**
 * Builds a definition from an explicit field allowlist. Callers pass only definition fields; there
 * is no path from a task, conversation, connection or evidence row into this object.
 */
export function toPortable(source: PortableSource): PortableDefinition {
  return portableDefinitionSchema.parse({
    format: PORTABLE_FORMAT,
    kind: 'teammate',
    name: source.name,
    role: source.role,
    instructions: source.instructions,
    capabilityRequests: [...source.capabilityRequests],
    skills: source.skills.map((skill) => ({ ...skill })),
    parameters: [...new Set(source.skills.flatMap((skill) => skill.inputs))].map((input) => ({
      name: input.name,
      description: input.description,
    })),
  });
}

export type ImportResult =
  | { readonly ok: true; readonly definition: PortableDefinition }
  | {
      readonly ok: false;
      readonly error: 'invalid_definition' | 'contains_secrets';
      readonly findings: readonly PortableFinding[];
    };

/** Strict parse: unknown keys (a smuggled `connections` or `token` field) reject the whole file. */
export function parsePortable(raw: string, knownPrivate: readonly string[]): ImportResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_definition', findings: [] };
  }
  const parsed = portableDefinitionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'invalid_definition', findings: [] };
  const findings = inspectPortable(parsed.data, knownPrivate).filter(
    (finding) => finding.kind === 'secret',
  );
  if (findings.length > 0) return { ok: false, error: 'contains_secrets', findings };
  return { ok: true, definition: parsed.data };
}
