import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createGroupResolver, createRoleResolver } from '../auth/directory.js';
import { createIapVerifier } from '../auth/iap.js';
import { createMetadataAccessToken } from '../auth/metadata-access-token.js';
import { createHttpOAuthProvider } from '../credentials/provider.js';
import { createHttpDrive } from '../retrieval/http-drive.js';

import type { VertexOptions } from '../agent/scripted-runner.js';
import type { Config } from '../config.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Builds the network-facing adapters from configuration. Construction makes no network call. */
export function buildProviderPorts(config: Config, env: Env, now: () => Date) {
  const oauthUrl = env.OAUTH_URL;
  const vertex = vertexOptions(env);
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
    runner: (model?: string) =>
      createScriptedRunner({
        baseUrl: config.llmUrl,
        model: model ?? env.LLM_MODEL,
        vertex,
      }),
  };
}

/**
 * `LLM_PROVIDER=vertex` selects Vertex AI with the Cloud Run service account's token, so no API key exists.
 * Any other value keeps the plain Gemini path used by the dev and e2e stacks.
 */
function vertexOptions(env: Env): VertexOptions | undefined {
  if (env.LLM_PROVIDER !== 'vertex') return undefined;
  const project = env.VERTEX_PROJECT;
  const location = env.VERTEX_LOCATION;
  if (project === undefined || project === '' || location === undefined || location === '') {
    throw new Error('LLM_PROVIDER=vertex requires VERTEX_PROJECT and VERTEX_LOCATION');
  }
  return { project, location, accessToken: createMetadataAccessToken() };
}
