import { governanceHash } from '@agent-works/domain/data-governance';
import { describe, expect, it } from 'vitest';

import { createArtifactStore } from './artifact-store.js';
import { createCloudKmsStub } from './cloud-kms.js';
import {
  decryptArtifact,
  decryptPayload,
  encryptArtifact,
  encryptPayload,
  envelopeContext,
} from './encryption.js';
import { createLocalKms } from './local-kms.js';
import { CREATED, governanceFixture, readContext, recordFixture, SECRET } from './test-fixtures.js';

describe('authenticated envelope encryption', () => {
  it('randomizes data keys and nonces even for identical plaintext', async () => {
    const keys = createLocalKms();
    const first = await encryptArtifact(keys, recordFixture(), SECRET);
    const second = await encryptArtifact(keys, recordFixture(), SECRET);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(await decryptArtifact(keys, recordFixture(), first)).toBe(SECRET);
  });
  it('fails with a different provider even when key ids match', async () => {
    const first = createLocalKms('same-id');
    const second = createLocalKms('same-id');
    const envelope = await encryptArtifact(first, recordFixture(), SECRET);
    await expect(decryptArtifact(second, recordFixture(), envelope)).rejects.toThrow(
      'key unavailable',
    );
  });
  it('rotates without breaking old envelopes and revokes one version only', async () => {
    const keys = createLocalKms('old');
    const old = await encryptArtifact(keys, recordFixture(), SECRET);
    keys.rotate('new');
    const next = await encryptArtifact(keys, recordFixture(), SECRET);
    expect(await decryptArtifact(keys, recordFixture(), old)).toBe(SECRET);
    expect(await decryptArtifact(keys, recordFixture(), next)).toBe(SECRET);
    keys.revoke('old');
    await expect(decryptArtifact(keys, recordFixture(), old)).rejects.toThrow('key unavailable');
    expect(await decryptArtifact(keys, recordFixture(), next)).toBe(SECRET);
  });
  it('does not allow key id reuse after revocation', () => {
    const keys = createLocalKms();
    keys.revoke('local-key-1');
    expect(() => keys.rotate('local-key-1')).toThrow('key unavailable');
  });
  it('rejects every authenticated envelope component when tampered', async () => {
    const keys = createLocalKms();
    const envelope = await encryptArtifact(keys, recordFixture(), SECRET);
    for (const field of [
      'wrappedKey',
      'wrappingNonce',
      'wrappingTag',
      'nonce',
      'tag',
      'ciphertext',
    ] as const) {
      const changed = { ...envelope, [field]: Buffer.alloc(32, 7).toString('base64') };
      await expect(decryptArtifact(keys, recordFixture(), changed)).rejects.toThrow(
        'key unavailable',
      );
    }
  });
  it('authenticates owner, region, origin, source and ACL evidence', async () => {
    const keys = createLocalKms();
    const record = recordFixture();
    const envelope = await encryptArtifact(keys, record, SECRET);
    for (const field of ['owner', 'region', 'origin', 'sourceId', 'aclEvidenceRef'] as const) {
      const changed = { ...record, provenance: { ...record.provenance, [field]: 'forged' } };
      await expect(decryptArtifact(keys, changed, envelope)).rejects.toThrow('key unavailable');
    }
  });
  it('authenticates classification, identity, hash and retention', async () => {
    const keys = createLocalKms();
    const record = recordFixture();
    const envelope = await encryptArtifact(keys, record, SECRET);
    for (const changed of [
      { ...record, classification: 'PUBLIC' as const },
      { ...record, id: 'other-artifact' },
      { ...record, taskId: 'other-task' },
      { ...record, retentionClass: 'forever' },
      { ...record, canonicalHash: governanceHash('other') },
      { ...record, expiresAt: '2026-01-04T00:00:00.000Z' },
    ])
      await expect(decryptArtifact(keys, changed, envelope)).rejects.toThrow('key unavailable');
  });
  it('legal-hold summary changes do not require re-encryption', async () => {
    const keys = createLocalKms();
    const record = recordFixture();
    const envelope = await encryptArtifact(keys, record, SECRET);
    expect(envelopeContext(record)).toBe(envelopeContext({ ...record, legalHold: true }));
    expect(await decryptArtifact(keys, { ...record, legalHold: true }, envelope)).toBe(SECRET);
  });
  it('refuses a caller-supplied hash that does not match the plaintext', async () => {
    await expect(encryptArtifact(createLocalKms(), recordFixture(), 'other-text')).rejects.toThrow(
      'hash mismatch',
    );
  });
  it('handles empty, binary-like and multilingual text without loss', async () => {
    const keys = createLocalKms();
    for (const text of ['', '\u0000\n\r\t', '日本語 😀 café']) {
      const encrypted = await encryptPayload(keys, 'context', text);
      expect(await decryptPayload(keys, 'context', encrypted)).toBe(text);
      await expect(decryptPayload(keys, 'other-context', encrypted)).rejects.toThrow(
        'key unavailable',
      );
    }
  });
  it('Cloud KMS is a feature-gated typed fail-closed stub', async () => {
    expect(() => createCloudKmsStub(false)).toThrow('disabled');
    const provider = createCloudKmsStub(true);
    await expect(provider.wrap(Buffer.alloc(32), 'context')).rejects.toThrow('key unavailable');
  });
  it('artifact-store read fails with a wrong key without exposing the envelope', async () => {
    const { port, store } = await governanceFixture();
    await store.put(recordFixture(), SECRET);
    const wrong = createArtifactStore(port, createLocalKms(), () => new Date(CREATED));
    await expect(wrong.read('artifact-1', readContext())).rejects.toThrow('key unavailable');
  });
});
