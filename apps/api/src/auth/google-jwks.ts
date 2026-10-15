import type { IapVerifierOptions } from './iap.js';

export const googleIapJwksUrl = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const googleIapIssuer = 'https://cloud.google.com/iap';

const pilotRegion = 'asia-northeast1';

const projectNumberPattern = /^\d+$/;
// Cloud Run service names: 1-63 chars, lowercase letters, digits and hyphens; start with a letter, no trailing hyphen.
const serviceNamePattern = /^[a-z][a-z0-9-]*$/;
const serviceNameMaxLength = 63;

export type GoogleIapConfigInput = {
  readonly projectNumber: string;
  readonly region: string;
  readonly serviceName: string;
};

export type GoogleIapConfig = {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
};

export function googleIapConfig(input: GoogleIapConfigInput): GoogleIapConfig {
  if (!projectNumberPattern.test(input.projectNumber)) {
    throw new Error(`invalid projectNumber: must contain digits only, got ${input.projectNumber}`);
  }
  if (input.region !== pilotRegion) {
    throw new Error(`invalid region: must be ${pilotRegion} per ADR 0003, got ${input.region}`);
  }
  if (
    !serviceNamePattern.test(input.serviceName) ||
    input.serviceName.length > serviceNameMaxLength ||
    input.serviceName.endsWith('-')
  ) {
    throw new Error(
      `invalid serviceName: must be a valid Cloud Run name, got ${input.serviceName}`,
    );
  }

  const audience = `/projects/${input.projectNumber}/locations/${input.region}/services/${input.serviceName}`;
  return {
    jwksUrl: googleIapJwksUrl,
    issuer: googleIapIssuer,
    audience,
  };
}

export function toIapVerifierOptions(
  config: GoogleIapConfig,
  overrides?: Pick<IapVerifierOptions, 'now' | 'fetch'>,
): IapVerifierOptions {
  return {
    ...config,
    ...overrides,
  };
}
