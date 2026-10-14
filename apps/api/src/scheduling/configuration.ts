import { readFileSync } from 'node:fs';

import * as z from 'zod';

import { schedulePrivilegeSchema } from '../../../../packages/domain/dist/schedule.js';
const label = z.string().min(1).max(256);
const configurationSchema = z.strictObject({
  authorities: z.array(z.strictObject({ subject: label, privilege: schedulePrivilegeSchema })),
  consents: z.array(
    z.strictObject({
      ref: label,
      subject: label,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.iso.datetime(),
    }),
  ),
  keys: z.array(
    z.strictObject({
      id: label,
      source: label,
      algorithm: z.enum(['HS256', 'RS256', 'EdDSA']),
      material: z.string().min(1),
      revoked: z.boolean(),
    }),
  ),
});
export type ScheduleConfiguration = z.infer<typeof configurationSchema>;
/** Trusted local operator input; never accepted from a webhook or task payload. */
export function readScheduleConfiguration(path: string | undefined): ScheduleConfiguration {
  if (path === undefined) return { authorities: [], consents: [], keys: [] };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit operator configuration path
  return configurationSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
