import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as z from 'zod';

import { createLocalKeyRegistry } from '../../../scheduling/keys.js';

import type { createBotTriggers } from './index.js';
import type { SigningKey } from '../../../scheduling/keys.js';

const keySchema = z.discriminatedUnion('algorithm', [
  z.strictObject({
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(256),
    algorithm: z.literal('HS256'),
    secretBase64: z.string().min(1),
  }),
  z.strictObject({
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(256),
    algorithm: z.enum(['RS256', 'EdDSA']),
    publicKeyPem: z.string().min(1),
  }),
]);

/** Thrown with field names only; key material never appears in a message. */
export class BotEventKeyConfigError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid AW_BOT_EVENT_KEYS: ${fields.join(', ')}`);
    this.name = 'BotEventKeyConfigError';
  }
}

/**
 * Parses the signed-event keys a segment accepts: one active key per source, validated by the
 * same rules as the scheduler's key registry (HS256 secrets of at least 32 bytes, RSA or Ed25519
 * public keys). An event is authenticated only by a key listed here.
 */
export function parseBotEventKeys(json: unknown): (source: string) => SigningKey | undefined {
  const parsed = z.array(keySchema).safeParse(json);
  if (!parsed.success)
    throw new BotEventKeyConfigError([
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || 'keys')),
    ]);
  const bySource = new Map<string, SigningKey>();
  const registry = createLocalKeyRegistry();
  for (const [index, entry] of parsed.data.entries()) {
    if (bySource.has(entry.source)) throw new BotEventKeyConfigError([`${index}.source`]);
    let key: SigningKey;
    try {
      key =
        entry.algorithm === 'HS256'
          ? {
              id: entry.id,
              source: entry.source,
              algorithm: 'HS256',
              secret: Buffer.from(entry.secretBase64, 'base64'),
              revoked: false,
            }
          : {
              id: entry.id,
              source: entry.source,
              algorithm: entry.algorithm,
              publicKey: createPublicKey(entry.publicKeyPem),
              revoked: false,
            };
      registry.put(key);
    } catch {
      throw new BotEventKeyConfigError([`${index}.key`]);
    }
    bySource.set(entry.source, key);
  }
  return (source) => bySource.get(source);
}

/** Reads AW_BOT_EVENT_KEYS (a JSON file path). Unset: no source is accepted. */
export async function readBotEventKeys(
  path: string | undefined,
): Promise<(source: string) => SigningKey | undefined> {
  if (path === undefined || path === '') return () => undefined;
  let json: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-owned configuration path
    json = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new BotEventKeyConfigError(['file']);
  }
  return parseBotEventKeys(json);
}

/** Evaluates schedule triggers on an interval; a tick never overlaps the previous one. */
export function createTriggerLoop(
  triggers: ReturnType<typeof createBotTriggers>,
  intervalMs: number,
  onError: (error: unknown) => void,
) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const run = () => {
    if (running) return;
    running = triggers
      .tick()
      .then(() => undefined, onError)
      .finally(() => {
        running = undefined;
      });
  };
  return {
    start() {
      if (timer) return;
      run();
      timer = setInterval(run, intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
