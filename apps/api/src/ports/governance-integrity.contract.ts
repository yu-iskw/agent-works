import { governanceHash } from '@agent-works/domain/data-governance';
import { expect, it } from 'vitest';

import { requestDeletion } from '../governance/deletion-requests.js';
import { changeLegalHold } from '../governance/holds.js';
import { purgeArtifact } from '../governance/purge.js';
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

import type { GovernancePort, GovernanceState } from './governance.js';

const officer = 'officer';
const artifactId = 'artifact-1';
const purgeEvidenceError = 'purge evidence';
const activeHoldError = 'active hold';

/** State integrity is part of the shared adapter contract, including direct
 * transaction callers rather than only the higher-level service paths. */
export function governanceIntegrityContract(fresh: () => GovernancePort): void {
  it.each([
    { kind: 'record', id: artifactId },
    { kind: 'owner', id: 'alice' },
    { kind: 'source', id: 'source-1' },
  ] as const)(
    'rolls back direct removal under an active $kind hold, even with purge evidence',
    async (target) => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      await store.derive(artifactId, 'derived-1', 'index', SECRET);
      await changeLegalHold(
        port,
        { commandId: HOLD_ID, target, action: 'set', reasonRef: 'case' },
        officer,
        new Date(CREATED),
      );
      const before = await port.snapshot();
      for (const evidence of ['none', 'tombstone', 'audit'] as const) {
        await expect(
          port.transact((state) => {
            state.artifacts = [];
            state.derived = [];
            if (evidence !== 'none') addPurgeEvidence(state, evidence, artifactId);
          }),
        ).rejects.toThrow(activeHoldError);
        expect(await port.snapshot()).toEqual(before);
      }
      // A release and its purge may commit together; the final hold state governs eligibility.
      await port.transact((state) => {
        state.holds.push({
          ...state.holds[0],
          commandId: REQUEST_ID,
          action: 'release',
          sequence: 2,
        });
        expect(
          purgeArtifact(state, state.artifacts[0], {
            reason: 'retention',
            requestId: null,
            at: EXPIRED.toISOString(),
            actor: officer,
          }),
        ).toBe(true);
      });
      const after = await port.snapshot();
      expect(after.artifacts).toEqual([]);
      expect(after.derived).toEqual([]);
      expect(after.tombstones).toHaveLength(1);
      expect(after.audit.filter((row) => row.type === 'purge')).toHaveLength(1);
    },
  );

  derivedRemovalContract(fresh);
  survivingContentContract(fresh);

  it('rolls back direct removal without purge evidence after a hold release', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'index', SECRET);
    const command = {
      commandId: HOLD_ID,
      target: { kind: 'record' as const, id: artifactId },
      action: 'set' as const,
      reasonRef: 'case',
    };
    await changeLegalHold(port, command, officer, new Date(CREATED));
    await changeLegalHold(
      port,
      { ...command, commandId: REQUEST_ID, action: 'release' },
      officer,
      EXPIRED,
    );
    const before = await port.snapshot();
    await expect(
      port.transact((state) => {
        state.artifacts = [];
        state.derived = [];
      }),
    ).rejects.toThrow(purgeEvidenceError);
    expect(await port.snapshot()).toEqual(before);
  });

  it.each(['tombstone', 'audit'] as const)(
    'requires matching %s evidence for direct removal',
    async (evidence) => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      await store.derive(artifactId, 'derived-1', 'index', SECRET);
      const before = await port.snapshot();
      await expect(
        port.transact((state) => {
          state.artifacts = [];
          state.derived = [];
          addPurgeEvidence(state, evidence, 'another-artifact');
        }),
      ).rejects.toThrow(purgeEvidenceError);
      expect(await port.snapshot()).toEqual(before);
      await port.transact((state) => {
        state.artifacts = [];
        state.derived = [];
        addPurgeEvidence(state, evidence, artifactId);
      });
      const after = await port.snapshot();
      expect(after.artifacts).toEqual([]);
      expect(after.derived).toEqual([]);
      expect(evidence === 'tombstone' ? after.tombstones : after.audit).toHaveLength(1);
    },
  );

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

function survivingContentContract(fresh: () => GovernancePort): void {
  it.each([
    { kind: 'record', id: artifactId },
    { kind: 'owner', id: 'alice' },
    { kind: 'source', id: 'source-1' },
  ] as const)(
    'rolls back in-place content mutations under an active $kind hold',
    async (target) => {
      const { port, store } = await governanceFixture(fresh());
      await store.put(recordFixture(), SECRET);
      await store.derive(artifactId, 'derived-1', 'index', SECRET);
      await changeLegalHold(
        port,
        { commandId: HOLD_ID, target, action: 'set', reasonRef: 'case' },
        officer,
        new Date(CREATED),
      );
      const before = await port.snapshot();
      for (const collection of ['artifacts', 'derived'] as const) {
        for (const field of [
          'ciphertext',
          'keyId',
          'wrappedKey',
          'wrappingNonce',
          'wrappingTag',
          'nonce',
          'tag',
          'aadHash',
        ] as const) {
          await expect(
            port.transact((state) => {
              const row = collection === 'artifacts' ? state.artifacts[0] : state.derived[0];
              const envelope = row.envelope;
              Object.assign(envelope, {
                [field]: field === 'aadHash' ? '0'.repeat(64) : 'QUFB',
              });
              if (field === 'ciphertext') envelope.ciphertext = '';
            }),
          ).rejects.toThrow(activeHoldError);
          expect(await port.snapshot()).toEqual(before);
        }
      }
      await expect(
        port.transact((state) => {
          state.artifacts[0].record.provenance.owner = 'bob';
          state.artifacts[0].record.provenance.sourceId = 'other-source';
          state.artifacts[0].record.legalHold = target.kind === 'record';
        }),
      ).rejects.toThrow(activeHoldError);
      await expect(
        port.transact((state) => {
          state.derived[0].kind = 'cache';
        }),
      ).rejects.toThrow(activeHoldError);
      expect(await port.snapshot()).toEqual(before);
    },
  );

  it('rejects unauthorised envelope replacement without a hold, including after release', async () => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'index', SECRET);
    for (const held of [false, true]) {
      if (held) {
        const command = {
          commandId: HOLD_ID,
          target: { kind: 'record' as const, id: artifactId },
          action: 'set' as const,
          reasonRef: 'case',
        };
        await changeLegalHold(port, command, officer, new Date(CREATED));
        await changeLegalHold(
          port,
          { ...command, commandId: REQUEST_ID, action: 'release' },
          officer,
          EXPIRED,
        );
      }
      const before = await port.snapshot();
      for (const collection of ['artifacts', 'derived'] as const) {
        await expect(
          port.transact((state) => {
            const row = collection === 'artifacts' ? state.artifacts[0] : state.derived[0];
            row.envelope.ciphertext = '';
          }),
        ).rejects.toThrow('immutable');
        expect(await port.snapshot()).toEqual(before);
      }
    }
  });
}

function derivedRemovalContract(fresh: () => GovernancePort): void {
  it.each([
    { kind: 'record', id: artifactId },
    { kind: 'owner', id: 'alice' },
    { kind: 'source', id: 'source-1' },
  ] as const)('protects derived rows independently under an active $kind hold', async (target) => {
    const { port, store } = await governanceFixture(fresh());
    await store.put(recordFixture(), SECRET);
    await store.derive(artifactId, 'derived-1', 'index', SECRET);
    const command = { commandId: HOLD_ID, target, action: 'set' as const, reasonRef: 'case' };
    await changeLegalHold(port, command, officer, new Date(CREATED));
    const before = await port.snapshot();
    for (const evidence of ['none', 'audit'] as const) {
      await expect(
        port.transact((state) => {
          state.derived = [];
          if (evidence === 'audit') addPurgeEvidence(state, evidence, artifactId);
        }),
      ).rejects.toThrow(activeHoldError);
      expect(await port.snapshot()).toEqual(before);
    }
    await changeLegalHold(
      port,
      { ...command, commandId: REQUEST_ID, action: 'release' },
      officer,
      EXPIRED,
    );
    const released = await port.snapshot();
    for (const evidence of ['none', 'unrelated'] as const) {
      await expect(
        port.transact((state) => {
          state.derived = [];
          if (evidence === 'unrelated') addPurgeEvidence(state, 'audit', 'another-artifact');
        }),
      ).rejects.toThrow(purgeEvidenceError);
      expect(await port.snapshot()).toEqual(released);
    }
    await port.transact((state) => {
      state.derived = [];
      addPurgeEvidence(state, 'audit', artifactId);
    });
    expect((await port.snapshot()).derived).toEqual([]);
    expect((await port.snapshot()).artifacts).toEqual(released.artifacts);
  });
}

function addPurgeEvidence(
  state: GovernanceState,
  evidence: 'tombstone' | 'audit',
  id: string,
): void {
  if (evidence === 'tombstone') {
    const record = recordFixture(id);
    state.tombstones.push({
      recordId: id,
      ownerHash: governanceHash(record.provenance.owner),
      sourceHash: governanceHash(record.provenance.sourceId),
      canonicalHash: record.canonicalHash,
      requestId: null,
      purgedAt: EXPIRED.toISOString(),
      reason: 'retention',
    });
  } else {
    state.audit.push({
      eventId: `purge:${governanceHash(id)}`,
      type: 'purge',
      occurredAt: EXPIRED.toISOString(),
      actorHash: governanceHash(officer),
      targetHash: governanceHash(id),
      requestId: null,
      state: null,
      redactionMarker: 'governance-tombstone-v1',
    });
  }
}
