import { z } from 'zod';

import {
  DEFAULT_PREFERENCES,
  PANEL_WIDTH,
  SEND_KEYS,
  SIDEBAR_TABS,
  STARTUPS,
  THEMES,
} from '../../shared/contract.js';

import type { Preferences, PreferencesPatch } from '../../shared/contract.js';
import type { WebDb } from '../m1/db.js';

/** Member-scope rows live under this scope; segment-scope rows under the segment id. */
const MEMBER_SCOPE = '*';

const lastContextSchema = z
  .strictObject({ teammateId: z.string().uuid(), tab: z.enum(SIDEBAR_TABS) })
  .nullable();

/** One closed schema per stored key; a row that fails its schema counts as absent. */
const VALUE_SCHEMAS = {
  theme: z.enum(THEMES),
  startup: z.enum(STARTUPS),
  sendKey: z.enum(SEND_KEYS),
  panelWidth: z.number().int().min(PANEL_WIDTH.min).max(PANEL_WIDTH.max),
  lastContext: lastContextSchema,
} as const;

type Key = keyof typeof VALUE_SCHEMAS;
const MEMBER_KEYS: readonly Key[] = ['theme', 'startup', 'sendKey', 'panelWidth'];
const scopeOf = (key: Key, segment: string) => (key === 'lastContext' ? segment : MEMBER_SCOPE);

export const preferencesPatchSchema = z.strictObject({
  theme: VALUE_SCHEMAS.theme.optional(),
  startup: VALUE_SCHEMAS.startup.optional(),
  sendKey: VALUE_SCHEMAS.sendKey.optional(),
  panelWidth: VALUE_SCHEMAS.panelWidth.optional(),
  lastContext: VALUE_SCHEMAS.lastContext.optional(),
});

export type StoredRow = { readonly scope: string; readonly key: string; readonly value: unknown };

/** Folds stored rows into full preferences; unknown keys, foreign scopes and bad values are ignored. */
export function preferencesFromRows(rows: readonly StoredRow[], segment: string): Preferences {
  const out: Record<Key, unknown> = { ...DEFAULT_PREFERENCES };
  for (const row of rows) {
    if (!Object.hasOwn(VALUE_SCHEMAS, row.key)) continue;
    const key = row.key as Key;
    if (row.scope !== scopeOf(key, segment)) continue;
    // eslint-disable-next-line security/detect-object-injection
    const parsed = VALUE_SCHEMAS[key].safeParse(row.value);
    // eslint-disable-next-line security/detect-object-injection
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Preferences;
}

export type PreferencesStore = {
  read(sub: string, segment: string): Promise<Preferences>;
  write(sub: string, segment: string, patch: PreferencesPatch): Promise<Preferences>;
};

export function createPreferencesStore(db: Pick<WebDb, 'sql'>): PreferencesStore {
  async function read(sub: string, segment: string): Promise<Preferences> {
    const rows = await db.sql<StoredRow[]>`
      select scope, key, value from m1_preferences where sub = ${sub} and scope in (${MEMBER_SCOPE}, ${segment})
    `;
    return preferencesFromRows(rows, segment);
  }
  return {
    read,
    async write(sub, segment, patch) {
      for (const key of [...MEMBER_KEYS, 'lastContext'] as const) {
        if (!(key in patch)) continue;
        // eslint-disable-next-line security/detect-object-injection
        const value = JSON.stringify(patch[key] ?? null);
        await db.sql`
          insert into m1_preferences (sub, scope, key, value, updated_at)
          values (${sub}, ${scopeOf(key, segment)}, ${key}, ${value}::jsonb, now())
          on conflict (sub, scope, key) do update set value = excluded.value, updated_at = excluded.updated_at
        `;
      }
      return read(sub, segment);
    },
  };
}
