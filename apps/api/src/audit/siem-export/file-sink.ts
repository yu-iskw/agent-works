import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { sealExport, sealedExportSchema, siemEventSchema, verifyExports } from './format.js';
import { existingExport } from './sink-port.js';

import type { SealedExport } from './format.js';
import type { SiemSink } from './sink-port.js';

/** Local prototype only. Exclusive files and chain verification detect mutation;
 * production WORM/retention and dedicated SIEM roles remain gated by D-08. */
export function createFileSiemSink(directory: string): SiemSink {
  const lockPath = join(directory, '.append-lock');
  async function read(): Promise<readonly SealedExport[]> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const names = (await readdir(directory)).filter((name) => /^\d{16}\.json$/.test(name)).sort();
    const links: SealedExport[] = [];
    for (const name of names) {
      links.push(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        sealedExportSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))),
      );
    }
    verifyExports(links);
    return links;
  }
  return {
    read,
    async append(input) {
      const event = siemEventSchema.parse(input);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Cross-process contention fails closed. Operators retry after resolving a stale lock.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const lock = await open(lockPath, 'wx', 0o600);
      try {
        const links = await read();
        const existing = existingExport(links, event);
        if (existing !== undefined) return existing;
        const link = sealExport(event, links.at(-1));
        const path = join(directory, `${String(link.sequence).padStart(16, '0')}.json`);
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(link) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        return link;
      } finally {
        await lock.close();
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await unlink(lockPath);
      }
    },
  };
}
