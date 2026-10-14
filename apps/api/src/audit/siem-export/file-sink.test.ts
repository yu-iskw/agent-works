import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { auditFixture } from '../../reliability/fixtures.js';
import { createRedactor } from '../../telemetry/events-redaction.js';

import { createFileSiemSink } from './file-sink.js';
import { projectAudit } from './format.js';

it('persists an immutable redacted chain across sink restart and detects file mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue135-siem-'));
  try {
    const redactor = createRedactor('local-fixture-redaction-key');
    const sink = createFileSiemSink(directory);
    const event = projectAudit(auditFixture(), redactor);
    const first = await sink.append(event);
    const restart = createFileSiemSink(directory);
    expect(await restart.append(event)).toEqual(first);
    await restart.append(projectAudit(auditFixture(1), redactor));
    expect(await restart.read()).toHaveLength(2);
    const path = join(directory, '0000000000000001.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const body = await readFile(path, 'utf8');
    expect(body).not.toContain('alice');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(path, JSON.stringify({ ...first, digest: '0'.repeat(64) }));
    await expect(restart.read()).rejects.toThrow('integrity');
  } finally {
    // Removes only disposable fixture output, never retained audit evidence.

    await rm(directory, { recursive: true, force: true });
  }
});
