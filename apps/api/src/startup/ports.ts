import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createGroupResolver, createRoleResolver } from '../auth/directory.js';
import { createIapVerifier } from '../auth/iap.js';
import { createHttpOAuthProvider } from '../credentials/provider.js';
import { createHttpDrive } from '../retrieval/http-drive.js';

import type { Config } from '../config.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Builds the network-facing adapters from configuration. Construction makes no network call. */
export function buildProviderPorts(config: Config, env: Env, now: () => Date) {
  const oauthUrl = env.OAUTH_URL;
  return {
    iap: createIapVerifier(config.iap),
    groups: createGroupResolver({ baseUrl: config.directoryUrl }),
    rolesFor: createRoleResolver({ baseUrl: config.directoryUrl }),
    drive: createHttpDrive({
      baseUrl: config.driveUrl,
      directoryUrl: config.directoryUrl,
      workerToken: env.AW_DEV_STACK === '1' ? env.DRIVE_WORKER_TOKEN : undefined,
      now,
    }),
    oauthUrl,
    oauthProvider:
      oauthUrl === undefined
        ? undefined
        : createHttpOAuthProvider(oauthUrl, config.oauthRedirectUri, env.OAUTH_PUBLIC_URL),
    runner: (model?: string) => createScriptedRunner({ baseUrl: config.llmUrl, model }),
  };
}
