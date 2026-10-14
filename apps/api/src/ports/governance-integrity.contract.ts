import { expect, it } from 'vitest';

import { requestDeletion } from '../governance/deletion-requests.js';
import { changeLegalHold } from '../governance/holds.js';
import { sweepRetention } from '../governance/retention-sweeper.js';
import {
  CREATED,
  EXPIRED,
  governanceFixture,
  HOLD_ID,
  POLICY,
  recordFixture,
  REQUEST_ID,
  SECRET,
} from '../governance/test-fixtures.js';

import type { GovernancePort } from './governance.js';

const officer = 'officer';
const artifactId = 'artifact-1';

/** State integrity is part of the shared adapter contract, including direct
 * transaction callers rather than only the higher-level service paths. */
export function governanceIntegrityContract(fresh: () => GovernancePort): void {
  it('rolls back schema-invalid artifact and orphan derived mutations', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'index', SECRET);
    const before = await port.snapshot();
    await expect(
      port.transact((state) => {
        state.artifacts = [];
      }),
    ).rejects.toThrow('orphan');
    await expect(
      port.transact((state) => {
        state.artifacts[0].record.retentionClass = 'missing';
      }),
    ).rejects.toThrow('retention');
    await expect(
      port.transact((state) => {
        state.artifacts[0].record.legalHold = true;
      }),
    ).rejects.toThrow('hold summary');
    expect(await port.snapshot()).toEqual(before);
  });

  it('rolls back if a callback returns a value that cannot cross the port boundary', async () => {
    const port = fresh();
    await expect(
      port.transact((state) => {
        state.policies.push(POLICY);
        return () => undefined;
      }),
    ).rejects.toThrow();
    expect((await port.snapshot()).policies).toEqual([]);
    await port.transact((state) => {
      state.policies.push(POLICY);
    });
    expect((await port.snapshot()).policies).toEqual([POLICY]);
  });

  it('rejects duplicate identities atomically', async () => {
    const { port } = await governanceFixture(fresh());
    await expect(
      port.transact((state) => {
        state.policies.push(POLICY);
      }),
    ).rejects.toThrow('duplicate');
    expect((await port.snapshot()).policies).toEqual([POLICY]);
  });

  it('rejects request identity changes and unaudited state advances', async () => {
    const port = fresh();
    await requestDeletion(
      port,
      { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' },
      officer,
      new Date(CREATED),
    );
    const before = await port.snapshot();
    await expect(
      port.transact((state) => {
        state.requests[0].subject = 'bob';
      }),
    ).rejects.toThrow();
    await expect(
      port.transact((state) => {
        state.requests[0].reasonRef = 'changed';
      }),
    ).rejects.toThrow('identity');
    await expect(
      port.transact((state) => {
        state.requests[0].state = 'PURGED';
      }),
    ).rejects.toThrow('summary');
    await expect(
      port.transact((state) => {
        state.requests[0].revision += 1;
      }),
    ).rejects.toThrow('evidence');
    expect(await port.snapshot()).toEqual(before);
  });

  it('serializes concurrent requests and retains one command and one audit event', async () => {
    const port = fresh();
    const command = { requestId: REQUEST_ID, subject: 'alice', reasonRef: 'privacy' };
    const [first, second] = await Promise.all([
      requestDeletion(port, command, officer, new Date(CREATED)),
      requestDeletion(port, command, officer, EXPIRED),
    ]);
    expect(second).toEqual(first);
    const state = await port.snapshot();
    expect(state.requests).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it('preserves an installed hold through concurrent sweep callers', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    // Install preservation before admitting sweep callers. Eligibility and purge
    // share a transaction rather than relying on a previous snapshot.
    await changeLegalHold(
      port,
      {
        commandId: HOLD_ID,
        target: { kind: 'record', id: artifactId },
        action: 'set',
        reasonRef: 'case',
      },
      officer,
      new Date(CREATED),
    );
    const reports = await Promise.all([
      sweepRetention(port, EXPIRED),
      sweepRetention(port, EXPIRED),
    ]);
    expect(reports).toEqual([
      { held: [artifactId], purged: [] },
      { held: [artifactId], purged: [] },
    ]);
    const state = await port.snapshot();
    expect(state.artifacts).toHaveLength(1);
    expect(state.audit.filter((row) => row.type === 'purge')).toEqual([]);
  });

  it('purges at most once when separate callers sweep concurrently', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    const reports = await Promise.all([
      sweepRetention(port, EXPIRED),
      sweepRetention(port, EXPIRED),
    ]);
    expect(reports.flatMap((report) => report.purged)).toEqual([artifactId]);
    expect((await port.snapshot()).audit.filter((row) => row.type === 'purge')).toHaveLength(1);
  });
}
