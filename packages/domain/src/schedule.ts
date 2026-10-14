import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';
import { taskSubmitSchema } from './ledger.js';
import { principalSchema } from './principal.js';
import { validCron } from './schedule-cron.js';

export const scheduleLabel = z.string().min(1).max(256);
const uniqueLabels = z
  .array(scheduleLabel)
  .max(128)
  .refine((v) => new Set(v).size === v.length, 'duplicate authority');
export const schedulePrivilegeSchema = z.strictObject({
  scopes: uniqueLabels,
  sources: uniqueLabels,
  skill: z.strictObject({ id: scheduleLabel, version: scheduleLabel }),
  classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
  regions: uniqueLabels,
  budgetUsd: z.number().finite().nonnegative().max(1000000),
  deadlineSeconds: z.number().int().positive().max(86400),
});
export type SchedulePrivilege = z.infer<typeof schedulePrivilegeSchema>;
const scheduleWindowSchema = z.strictObject({
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((v) => new Set(v).size === v.length),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});
const scheduleTimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(60).max(31536000),
    anchor: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('cron'),
    expression: z.string().max(128).refine(validCron, 'invalid five-field cron'),
  }),
]);
const scheduleTimezoneSchema = scheduleLabel.refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'invalid timezone');
const scheduleRevocationSchema = z.strictObject({ onRevocation: z.literal('cancel-in-flight') });
export const scheduleSpecSchema = z
  .strictObject({
    id: z.uuid(),
    sponsor: principalSchema.options[0],
    purpose: z.string().min(1).max(2000),
    consentRef: scheduleLabel,
    maxPrivilege: schedulePrivilegeSchema,
    task: taskSubmitSchema,
    timing: scheduleTimingSchema,
    timezone: scheduleTimezoneSchema,
    allowedWindow: scheduleWindowSchema,
    expiresAt: z.iso.datetime(),
    misfire: z.enum(['skip', 'catch-up-once']),
    revocation: scheduleRevocationSchema,
  })
  .superRefine((value, ctx) => {
    const p = value.maxPrivilege;
    if (
      value.task.skillId !== p.skill.id ||
      value.task.executionPolicy.budgetUsd > p.budgetUsd ||
      value.task.executionPolicy.deadlineSeconds > p.deadlineSeconds ||
      value.task.sourceAllowlist.some((source) => !p.sources.includes(source))
    )
      ctx.addIssue({ code: 'custom', message: 'task exceeds pinned privilege' });
    if (
      value.task.input !== undefined &&
      ['scopes', 'userId', 'agentIdentity', 'authority', 'privilege'].some(
        (key) => key in value.task.input!,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'authority fields are forbidden in task input' });
  });
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;
export const scheduleRecordSchema = z
  .strictObject({
    spec: scheduleSpecSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['active', 'paused', 'revoked']),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cursor: z.iso.datetime(),
  })
  .refine((row) => row.digest === scheduleHash(row.spec), 'schedule digest mismatch');
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;
export function scheduleHash(value: ScheduleSpec): string {
  const spec = scheduleSpecSchema.parse(value);
  const task = { ...spec.task };
  if (task.input === undefined) delete task.input;
  return canonicalPayloadSha256({ ...spec, task });
}
export function privilegeWithin(ceiling: SchedulePrivilege, authority: SchedulePrivilege): boolean {
  const levels = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
  return (
    ceiling.skill.id === authority.skill.id &&
    ceiling.skill.version === authority.skill.version &&
    ceiling.scopes.every((v) => authority.scopes.includes(v)) &&
    ceiling.sources.every((v) => authority.sources.includes(v)) &&
    ceiling.regions.every((v) => authority.regions.includes(v)) &&
    levels.indexOf(ceiling.classification) <= levels.indexOf(authority.classification) &&
    ceiling.budgetUsd <= authority.budgetUsd &&
    ceiling.deadlineSeconds <= authority.deadlineSeconds
  );
}
