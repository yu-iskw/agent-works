import { expect, test } from 'vitest';

import { parseAdminForm } from './form.js';
import { commandId, stopForm } from './test-helpers.js';

test('form maps to exact strict suspension command', () => {
  expect(parseAdminForm(stopForm('token'))).toEqual({
    kind: 'suspension',
    command: {
      commandId,
      action: 'suspend',
      target: { scope: 'global', id: '*', version: null },
      reason: 'Local stop',
      expiresAt: null,
      expectedRevision: 0,
    },
  });
});
test.each(['scope', 'id', 'reason', 'commandId'])('missing %s makes command invalid', (key) => {
  const form = stopForm('token');
  form.delete(key);
  expect(parseAdminForm(form)).toBeUndefined();
});
test('version form preserves pin and revision', () => {
  const form = new URLSearchParams({
    kind: 'version',
    commandId,
    capabilityKind: 'skill',
    id: 'incident',
    version: '1',
    state: 'revoked',
    reason: 'Leaked output',
    expectedRevision: '2',
  });
  expect(parseAdminForm(form)).toMatchObject({
    kind: 'version',
    command: {
      pin: { kind: 'skill', id: 'incident', version: '1' },
      state: 'revoked',
      expectedRevision: 2,
    },
  });
});
