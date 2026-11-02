import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSegmentConfig } from './config.js';
import { Conflict } from './context.js';
import { requireAdmin } from './routes.js';

import type { Member } from './context.js';

const local = (extra: Record<string, string>) =>
  readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test,bob@local.test',
    ...extra,
  });

function memberFor(email: string, admins: ReadonlySet<string>): Member {
  return { sub: `local-test:${email}`, email, admin: admins.has(email) };
}

function refusal(member: Member): unknown {
  try {
    requireAdmin(member);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('segment admin allowlist', () => {
  it('rejects an admin who is not a member', () => {
    const config = local({ AW_LOCAL_TEST_ADMINS: 'mallory@local.test' });

    expect(config.admins.size).toBe(0);
    const outsider = memberFor('mallory@local.test', config.admins);
    expect(refusal(outsider)).toBeInstanceOf(Conflict);
  });

  it('matches emails case-insensitively', () => {
    const config = local({
      AW_LOCAL_TEST_MEMBERS: 'Alice@Local.Test',
      AW_LOCAL_TEST_ADMINS: 'ALICE@local.test',
    });

    expect([...config.admins]).toEqual(['alice@local.test']);
    expect(() => requireAdmin(memberFor('alice@local.test', config.admins))).not.toThrow();
  });

  it('grants no admin when the list is empty or unset', () => {
    const unset = local({});
    const blank = local({ AW_LOCAL_TEST_ADMINS: ' , ' });

    for (const config of [unset, blank]) {
      expect(config.admins.size).toBe(0);
      expect(config.missing).not.toContain('AW_LOCAL_TEST_ADMINS');
      expect(refusal(memberFor('alice@local.test', config.admins))).toMatchObject({
        code: 'forbidden',
        status: 403,
      });
    }
  });

  it('forbids a plain member with a 403 and lets an admin through', () => {
    const config = local({ AW_LOCAL_TEST_ADMINS: 'alice@local.test' });

    expect(refusal(memberFor('bob@local.test', config.admins))).toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(() => requireAdmin(memberFor('alice@local.test', config.admins))).not.toThrow();
  });

  it('reports a listed admin that is not a member by key name only', () => {
    const config = local({ AW_LOCAL_TEST_ADMINS: 'mallory@local.test' });

    expect(config.missing).toContain('AW_LOCAL_TEST_ADMINS');
    expect(JSON.stringify(config.missing)).not.toContain('mallory');
  });

  it('reads the google admin list from the secrets file like members', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-admin-'));
    const file = join(dir, 'm1.env');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test fixture
    writeFileSync(
      file,
      'AW_M1_ALPHA_MEMBERS=alice@example.com,bob@example.com\nAW_M1_ALPHA_ADMINS=Alice@example.com\n',
    );

    const config = readSegmentConfig({
      AW_SEGMENT_ID: 'alpha',
      AW_SOURCE_MODE: 'fixture',
      AW_SECRETS_FILE: file,
    });

    expect([...config.admins]).toEqual(['alice@example.com']);
    expect(config.missing).not.toContain('AW_M1_ALPHA_ADMINS');
  });

  it('names the google admin key when it lists a non-member', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-admin-'));
    const file = join(dir, 'm1.env');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test fixture
    writeFileSync(
      file,
      'AW_M1_ALPHA_MEMBERS=alice@example.com\nAW_M1_ALPHA_ADMINS=eve@example.com\n',
    );

    const config = readSegmentConfig({
      AW_SEGMENT_ID: 'alpha',
      AW_SOURCE_MODE: 'fixture',
      AW_SECRETS_FILE: file,
    });

    expect(config.admins.size).toBe(0);
    expect(config.missing).toContain('AW_M1_ALPHA_ADMINS');
    expect(JSON.stringify(config.missing)).not.toContain('eve@example.com');
  });
});
