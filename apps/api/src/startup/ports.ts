import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createGroupResolver, createRoleResolver } from '../auth/directory.js';
import { createIapVerifier } from '../auth/iap.js';
import { createHttpOAuthProvider } from '../credentials/provider.js';
import { createHttpDrive } from '../retrieval/http-drive.js';

import type { Config } from '../config.js';
import type { GoogleSignIn } from '../credentials/provider.js';

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
        : createHttpOAuthProvider(
            oauthUrl,
            config.oauthRedirectUri,
            env.OAUTH_PUBLIC_URL,
            googleSignIn(env),
          ),
    runner: (model?: string) => createScriptedRunner({ baseUrl: config.llmUrl, model }),
  };
}

/** Google sign-in settings are non-secret. The client secret stays with aw-tool-broker. */
function googleSignIn(env: Env): GoogleSignIn | undefined {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const hostedDomain = env.OAUTH_HOSTED_DOMAIN;
  if (clientId === undefined || clientId.trim() === '') return undefined;
  if (hostedDomain === undefined || hostedDomain.trim() === '') return undefined;
  return { clientId, hostedDomain };
}
