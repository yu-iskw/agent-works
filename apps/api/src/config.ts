export type RunnerKind = 'scripted' | 'adk';

export type Config = {
  readonly port: number;
  readonly databaseUrl: string;
  readonly driveUrl: string;
  readonly llmUrl: string;
  readonly iap: {
    readonly jwksUrl: string;
    readonly issuer: string;
    readonly audience: string;
  };
};

export function readRunnerKind(env: Readonly<Record<string, string | undefined>>): RunnerKind {
  return env.AGENT_RUNNER === 'adk' ? 'adk' : 'scripted';
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const missing: string[] = [];
  const databaseUrl = read(env.DATABASE_URL, 'DATABASE_URL', missing);
  const driveUrl = read(env.DRIVE_URL, 'DRIVE_URL', missing);
  const llmUrl = read(env.LLM_URL, 'LLM_URL', missing);
  const jwksUrl = read(env.IAP_JWKS_URL, 'IAP_JWKS_URL', missing);
  const issuer = read(env.IAP_ISSUER, 'IAP_ISSUER', missing);
  const audience = read(env.IAP_AUDIENCE, 'IAP_AUDIENCE', missing);
  const port = readPort(env.PORT, missing);
  if (
    missing.length > 0 ||
    databaseUrl === undefined ||
    driveUrl === undefined ||
    llmUrl === undefined ||
    jwksUrl === undefined ||
    issuer === undefined ||
    audience === undefined ||
    port === undefined
  ) {
    throw new Error(`missing env: ${missing.join(', ')}`);
  }
  return {
    port,
    databaseUrl,
    driveUrl,
    llmUrl,
    iap: { jwksUrl, issuer, audience },
  };
}

function read(value: string | undefined, name: string, missing: string[]): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    missing.push(name);
    return undefined;
  }
  return value;
}

function readPort(value: string | undefined, missing: string[]): number | undefined {
  if (value === undefined || value.length === 0) return 8080;
  if (!/^\d+$/.test(value)) {
    missing.push('PORT');
    return undefined;
  }
  const port = Number(value);
  if (port > 65_535) {
    missing.push('PORT');
    return undefined;
  }
  return port;
}
