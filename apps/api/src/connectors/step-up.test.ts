import { describe, expect, it, vi } from 'vitest';

import { workspaceScopes } from '../../../../packages/domain/dist/workspace-tools.js';
import { beginWorkspaceStepUp } from '../credentials/flow.js';

import { connection } from './test-fixtures.js';

import type { OAuthFlow } from '../credentials/flow.js';
const start = {
  state: 'state-1',
  codeChallenge: 'A'.repeat(43),
  codeChallengeMethod: 'S256' as const,
};
function setup() {
  const begin = vi.fn<OAuthFlow['begin']>((_subject, input) =>
    Promise.resolve({ ...input, authorizationUrl: 'http://127.0.0.1/authorize' }),
  );
  const flow = { begin } as unknown as OAuthFlow;
  const read = vi.fn(() => Promise.resolve({ ...connection(), scope: 'openid' }));
  return {
    begin,
    flow,
    read,
    credentials: { read, save: (value: ReturnType<typeof connection>) => Promise.resolve(value) },
  };
}
describe('per-tool incremental scope flow', () => {
  it('requests exactly the existing grant plus the selected tool scope', async () => {
    const h = setup();
    const result = await beginWorkspaceStepUp(
      h.flow,
      h.credentials,
      'alice',
      'docs.createDraft',
      start,
    );
    expect(result.scope.split(' ').sort()).toEqual(
      [workspaceScopes['docs.createDraft'], 'openid'].sort(),
    );
    expect(h.begin).toHaveBeenCalledWith('alice', expect.objectContaining({ provider: 'google' }));
  });
  it('uses the caller when reading grant history', async () => {
    const h = setup();
    h.read.mockResolvedValue({ ...connection('bob'), scope: 'openid' });
    await beginWorkspaceStepUp(h.flow, h.credentials, 'bob', 'calendar.listEvents', start);
    expect(h.read).toHaveBeenCalledWith('bob', 'google');
  });
  it('deduplicates an already granted scope', async () => {
    const h = setup();
    h.read.mockResolvedValue({ ...connection(), scope: workspaceScopes['docs.createDraft'] });
    const result = await beginWorkspaceStepUp(
      h.flow,
      h.credentials,
      'alice',
      'docs.createDraft',
      start,
    );
    expect(result.scope).toBe(workspaceScopes['docs.createDraft']);
  });
  it('denies scope escalation for revoked connections', async () => {
    const h = setup();
    h.read.mockResolvedValue({ ...connection(), status: 'revoked', scope: 'openid' });
    await expect(
      beginWorkspaceStepUp(h.flow, h.credentials, 'alice', 'gmail.searchThreads', start),
    ).rejects.toThrow();
    expect(h.begin).not.toHaveBeenCalled();
  });
  it('cannot request the denied send scope', async () => {
    const h = setup();
    await expect(
      beginWorkspaceStepUp(h.flow, h.credentials, 'alice', 'gmail.send', start),
    ).rejects.toThrow();
    expect(h.begin).not.toHaveBeenCalled();
  });
  it('rejects stored grants belonging to another caller before requesting consent', async () => {
    const h = setup();
    await expect(
      beginWorkspaceStepUp(h.flow, h.credentials, 'bob', 'gmail.searchThreads', start),
    ).rejects.toThrow();
    expect(h.begin).not.toHaveBeenCalled();
  });
});
