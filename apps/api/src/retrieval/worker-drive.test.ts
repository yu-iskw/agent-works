import { createDrive, googleFakeTransport } from '@agent-works/fakes';
import { expect, it } from 'vitest';

import { createHttpDrive, DriveFault } from './http-drive.js';

it('worker retrieval preserves private and group sources without replaying a caller assertion', async () => {
  const drive = createDrive(undefined, 'worker-secret');
  const transport = googleFakeTransport(drive);
  const group = 'agent-users@company.example';
  let groups = [group];
  const load: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'directory.test')
      return Promise.resolve(
        Response.json({ sub: 'alice', groups, observedAt: '2026-10-15T00:00:00Z' }),
      );
    return transport(input, init);
  };
  const baseUrl = 'http://drive.test';
  const http = createHttpDrive({
    baseUrl,
    directoryUrl: 'http://directory.test',
    workerToken: 'worker-secret',
    fetch: load,
  });
  const scope = await http.openWorker('alice');
  expect(
    (await scope.port.search(scope.context, 'triage')).map((row) => row.sourceObjectId),
  ).toContain('alice-runbook');
  expect(
    (await scope.port.search(scope.context, 'benefits')).map((row) => row.sourceObjectId),
  ).toContain('shared-benefits');
  expect(await scope.port.search(scope.context, 'salary')).toEqual([]);
  groups = [];
  const revoked = await http.openWorker('alice');
  expect(await revoked.port.search(revoked.context, 'benefits')).toEqual([]);
  await expect(
    createHttpDrive({ baseUrl, workerToken: 'wrong', fetch: load }).openWorker('alice'),
  ).rejects.toBeInstanceOf(DriveFault);
  await expect(
    createHttpDrive({ baseUrl, fetch: load }).openWorker('alice'),
  ).rejects.toBeInstanceOf(DriveFault);
});
