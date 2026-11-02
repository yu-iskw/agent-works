import { pathToFileURL } from 'node:url';

const REGION = 'asia-northeast1';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PLACEHOLDER = /placeholder|changeme|change-me|replace-me|your-project|example|<|>|\$\{|todo/i;
const APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9._#:/-]{2,119}$/;
const SHA = /^[0-9a-f]{40}$/;

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function imagePattern(projectId, packageName) {
  return new RegExp(
    `^${REGION}-docker\\.pkg\\.dev/${escapeRegExp(projectId)}/aw-images/${packageName}@sha256:[0-9a-f]{64}$`,
  );
}

/**
 * Returns every reason the manual deploy inputs are not an approved,
 * digest-pinned dev deployment. An empty list means the inputs are acceptable.
 * Offline and pure: it never contacts a registry or Cloud Run.
 */
export function validateDeployInputs(env) {
  const errors = [];
  const projectId = env.TF_PROJECT_ID ?? '';

  if (env.INPUT_ENVIRONMENT !== 'dev') errors.push("only the 'dev' environment is allowed");

  if (!PROJECT_ID.test(projectId) || PLACEHOLDER.test(projectId)) {
    errors.push('TF_PROJECT_ID must be the real dev project id, not empty or a placeholder');
  }
  if ((env.DEPLOY_WIF_PROVIDER ?? '') === '' || PLACEHOLDER.test(env.DEPLOY_WIF_PROVIDER ?? '')) {
    errors.push('DEPLOY_WIF_PROVIDER must be set to the real Workload Identity Provider');
  }
  const expectedSa = `aw-deployer@${projectId}.iam.gserviceaccount.com`;
  if (env.DEPLOYER_SA !== expectedSa) errors.push(`DEPLOYER_SA must be ${expectedSa}`);

  if (!SHA.test(env.DEPLOY_SHA ?? '')) errors.push('sha must be 40-char lowercase hex');

  if (!APPROVAL_REF.test(env.APPROVAL_REF ?? '') || PLACEHOLDER.test(env.APPROVAL_REF ?? '')) {
    errors.push('approval_ref must reference the filled operator approval request');
  }

  if (!imagePattern(projectId, 'aw-web').test(env.WEB_IMAGE ?? '')) {
    errors.push(
      `web_image must be ${REGION}-docker.pkg.dev/${projectId}/aw-images/aw-web@sha256:<64-hex> (a tag is not a digest)`,
    );
  }
  if (!imagePattern(projectId, 'aw-api').test(env.API_IMAGE ?? '')) {
    errors.push(
      `api_image must be ${REGION}-docker.pkg.dev/${projectId}/aw-images/aw-api@sha256:<64-hex> (a tag is not a digest)`,
    );
  }
  return errors;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateDeployInputs(process.env);
  for (const error of errors) console.error(`Refusing deployment: ${error}.`);
  process.exit(errors.length === 0 ? 0 : 1);
}
