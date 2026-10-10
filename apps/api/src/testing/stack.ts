import { createServer } from 'node:http';

import { createDrive, createIapProxy, createLlm, fakeIap, listen } from '@agent-works/fakes';

import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createApp } from '../app.js';
import { createMemoryAuditLog } from '../audit/write.js';
import { Unavailable, createIapVerifier } from '../auth/iap.js';
import { createHttpDrive } from '../retrieval/http-drive.js';

import type { MemoryAuditLog } from '../audit/write.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { AskDeps } from '../routes/ask.js';
import type { Server } from 'node:http';

export { createMemoryAuditLog };

export type Stack = {
  readonly iapUrl: string;
  readonly apiUrl: string;
  readonly audit: MemoryAuditLog;
  close(): Promise<void>;
};

export async function startStack(overrides: Partial<AskDeps> = {}): Promise<Stack> {
  const closers: (() => Promise<void>)[] = [];
  try {
    const driveServer = await listen(createDrive(), 0);
    closers.push(driveServer.close);
    const llmServer = await listen(createLlm(), 0);
    closers.push(llmServer.close);
    const gate: { verify?: VerifyAssertion } = {};
    const memory = createMemoryAuditLog();
    const server = createServer(
      createApp({
        verify: (assertion) => {
          if (gate.verify === undefined) return Promise.reject(new Unavailable('jwks'));
          return gate.verify(assertion);
        },
        drive: createHttpDrive({ baseUrl: driveServer.url }),
        runner: createScriptedRunner({ baseUrl: llmServer.url }),
        audit: memory,
        now: () => new Date(),
        ...overrides,
      }),
    );
    const apiUrl = await listenNode(server);
    closers.push(() => closeServer(server));
    const iap = await listen(createIapProxy(apiUrl), 0);
    closers.push(iap.close);
    gate.verify = createIapVerifier({
      jwksUrl: `${iap.url}/jwks`,
      issuer: fakeIap.issuer,
      audience: fakeIap.audience,
    });
    return {
      iapUrl: iap.url,
      apiUrl,
      audit: memory,
      close: async () => {
        await closeAll(closers);
      },
    };
  } catch (error) {
    await closeAll(closers);
    throw error;
  }
}

function listenNode(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeAll(closers: (() => Promise<void>)[]): Promise<void> {
  for (const close of [...closers].reverse()) {
    await close();
  }
}
