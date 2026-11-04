import * as z from 'zod';

/** An unset field is empty, null, or one of these markers. Validation refuses all of them. */
const UNSET = new Set(['', 'unset', 'tbd', 'todo', 'placeholder', 'changeme']);
const isSet = (value: string): boolean => !UNSET.has(value.trim().toLowerCase());

const named = z.string().refine(isSet, 'must be set by the owner');

const alertDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  metric: z.enum([
    'dueToClaim.p95Ms',
    'backlog.oldestQueuedMs',
    'outbox.oldestPendingMs',
    'retries.amplification',
    'quota.costUtilization',
    'cost.unassigned.micros',
  ]),
  comparator: z.enum(['gt', 'gte']),
  /** Owner-set. No default exists in this repository. */
  threshold: z.number().finite().positive(),
  forSeconds: z.number().int().positive(),
  severity: z.enum(['page', 'ticket']),
  responder: z.strictObject({ name: named, contact: named }),
  runbook: z.strictObject({
    url: named.refine(
      (v) => v.startsWith('https://') || v.startsWith('docs/'),
      'runbook must be a https URL or docs/ path',
    ),
  }),
});
type AlertDefinition = z.infer<typeof alertDefinitionSchema>;

export type AlertValidation =
  | { readonly ok: true; readonly alerts: readonly AlertDefinition[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Parses a JSON alert proposal. Reports every unset or malformed field, never just the first. */
export function validateAlerts(text: string): AlertValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['not valid JSON'] };
  }
  const list = (raw as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, problems: ['alerts: empty'] };
  const problems: string[] = [];
  const alerts: AlertDefinition[] = [];
  list.forEach((entry, index) => {
    const parsed = alertDefinitionSchema.safeParse(entry);
    if (parsed.success) alerts.push(parsed.data);
    else
      for (const issue of parsed.error.issues)
        problems.push(`alerts[${index}].${issue.path.join('.')}: ${issue.message}`);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, alerts };
}
