import { describe, expect, it } from 'vitest';

import { toolManifestSchema } from './broker.js';
import {
  workspaceManifests,
  workspaceManifest,
  workspaceToolRef,
  workspaceScopes,
} from './workspace-tools.js';
describe('workspace manifest registry', () => {
  it('registers all requested capabilities plus a denied send declaration', () => {
    expect(workspaceManifests.map((manifest) => manifest.metadata.name)).toEqual([
      'docs.createDraft',
      'calendar.listEvents',
      'calendar.createEvent',
      'gmail.searchThreads',
      'gmail.createDraft',
      'gmail.send',
    ]);
  });
  it('validates every manifest against the shared manifest contract', () => {
    for (const manifest of workspaceManifests)
      expect(toolManifestSchema.parse(manifest)).toEqual(manifest);
  });
  it.each(['docs.createDraft', 'calendar.createEvent', 'gmail.createDraft'] as const)(
    'requires single-use approval for %s',
    (tool) => {
      const manifest = workspaceManifest(tool);
      expect(manifest.spec.sideEffect).toBe('WRITE_LOW');
      expect(manifest.spec.approval.required).toBe(true);
      expect(manifest.spec.permissions.userAuthority).toBe('delegated');
      expect(manifest.spec.execution.idempotency).toBe('required');
      expect(manifest.spec.evidence.logRequestDigest).toBe(true);
    },
  );
  it.each(['calendar.listEvents', 'gmail.searchThreads'] as const)(
    'declares caller-scoped read for %s',
    (tool) => {
      const manifest = workspaceManifest(tool);
      expect(manifest.spec.sideEffect).toBe('READ');
      expect(manifest.spec.approval.required).toBe(false);
      expect(manifest.spec.permissions.userAuthority).toBe('delegated');
      expect(new Map(Object.entries(workspaceScopes)).get(tool)).toMatch(
        /^https:\/\/www.googleapis.com\/auth\//,
      );
    },
  );
  it('makes send a denied EXTERNAL_SEND entry', () => {
    const manifest = workspaceManifest('gmail.send');
    expect(manifest.spec.sideEffect).toBe('EXTERNAL_SEND');
    expect(manifest.spec.approval.policy).toBe('default-deny');
    expect(manifest.spec.approval.required).toBe(true);
  });
  it('uses versioned refs for approval binding', () => {
    expect(workspaceToolRef('docs.createDraft')).toBe('docs.createDraft@1.0.0');
  });
  it('limits retries and redacts body fields', () => {
    for (const manifest of workspaceManifests) {
      expect(manifest.spec.execution.retries).toBe(2);
      expect(manifest.spec.evidence.redactFields).toContain('body');
      expect(manifest.spec.evidence.redactFields).toContain('description');
    }
  });
});
