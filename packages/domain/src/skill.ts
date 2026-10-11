import * as z from 'zod';

const label = z.string().min(1);

export const lifecycleSchema = z.enum([
  'DRAFT',
  'SECURITY_REVIEW',
  'EVALUATED',
  'APPROVED',
  'PUBLISHED',
  'DEPRECATED',
  'REVOKED',
]);

export const skillPinSchema = z.strictObject({
  id: label,
  version: label,
});

export const skillManifestSchema = z.strictObject({
  id: label,
  version: label,
  tools: z.array(label).min(1),
  state: lifecycleSchema,
});

export type SkillPin = z.infer<typeof skillPinSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
