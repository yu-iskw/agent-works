import { describe, expect, it } from 'vitest';

import { BotEventKeyConfigError, createTriggerLoop, parseBotEventKeys } from './config.js';

import type { createBotTriggers } from './index.js';

const secret = Buffer.alloc(32, 7).toString('base64');

describe('bot event keys', () => {
  it('resolves one HS256 key per source', () => {
    const keys = parseBotEventKeys([
      { id: 'k1', source: 'ci', algorithm: 'HS256', secretBase64: secret },
    ]);
    expect(keys('ci')).toMatchObject({ id: 'k1', source: 'ci', algorithm: 'HS256' });
    expect(keys('other')).toBeUndefined();
  });

  it('rejects short secrets, duplicate sources and unknown fields without echoing key material', () => {
    const short = Buffer.alloc(8, 1).toString('base64');
    const cases: unknown[] = [
      [{ id: 'k1', source: 'ci', algorithm: 'HS256', secretBase64: short }],
      [
        { id: 'k1', source: 'ci', algorithm: 'HS256', secretBase64: secret },
        { id: 'k2', source: 'ci', algorithm: 'HS256', secretBase64: secret },
      ],
      [{ id: 'k1', source: 'ci', algorithm: 'HS256', secretBase64: secret, extra: true }],
      [{ id: 'k1', source: 'ci', algorithm: 'RS256', publicKeyPem: 'not a key' }],
    ];
    for (const json of cases) {
      let caught: unknown;
      try {
        parseBotEventKeys(json);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BotEventKeyConfigError);
      const message = (caught as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain(short);
    }
  });
});

describe('trigger loop', () => {
  it('never overlaps ticks and waits for the running tick on stop', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const triggers = {
      tick: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active -= 1;
        return { started: 0, duplicate: 0, denied: 0, deferred: 0, missedDueToCapacity: 0 };
      },
    } as unknown as ReturnType<typeof createBotTriggers>;
    const loop = createTriggerLoop(triggers, 5, () => undefined);
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    const stopped = loop.stop();
    release?.();
    await stopped;
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });
});
