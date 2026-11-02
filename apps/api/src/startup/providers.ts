import { loadConfig } from '../config.js';

type StartupMode = 'production' | 'local';

type ProviderName =
  | 'identity'
  | 'model'
  | 'source-storage'
  | 'authority-persistence'
  | 'oauth-credentials'
  | 'required-config'
  | 'incident-ticketing';

type ProviderStatus = 'real' | 'local-fake' | 'disabled-optional' | 'missing';

/** `detail` names env variables only, never their values. */
export type ProviderReport = {
  readonly name: ProviderName;
  readonly status: ProviderStatus;
  readonly detail: string;
};

const LOCAL_FAKE = 'local-fake' as const;

type Env = Readonly<Record<string, string | undefined>>;

export class ProductionStartupRejected extends Error {
  constructor(readonly reports: readonly ProviderReport[]) {
    super(
      `production startup rejected: ${reports
        .map((report) => `${report.name}=${report.status} (${report.detail})`)
        .join('; ')}`,
    );
    this.name = 'ProductionStartupRejected';
  }
}

function envValue(env: Env, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key === name)?.[1];
}

function readStartupMode(env: Env): StartupMode {
  const mode = env.AW_MODE;
  if (mode === undefined || mode === '' || mode === 'local') return 'local';
  if (mode === 'production') return 'production';
  throw new Error('AW_MODE must be "production" or "local"');
}

const loopbackSuffixes = ['.localhost', '.test', '.local', '.example'];

function parse(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '');
  return (
    name === 'localhost' ||
    name === '::1' ||
    /^127\./.test(name) ||
    name === '0.0.0.0' ||
    !name.includes('.') ||
    loopbackSuffixes.some((suffix) => name.endsWith(suffix))
  );
}

type UrlState = 'missing' | 'local' | 'real';

function urlState(value: string | undefined): UrlState {
  const url = parse(value);
  if (url === undefined) return 'missing';
  return url.protocol === 'https:' && !isLocalHost(url.hostname) ? 'real' : 'local';
}

function combine(states: readonly UrlState[]): UrlState {
  if (states.includes('missing')) return 'missing';
  return states.includes('local') ? 'local' : 'real';
}

function fromUrls(
  name: ProviderName,
  vars: readonly string[],
  env: Env,
  devStack: boolean,
): ProviderReport {
  const state = combine(vars.map((variable) => urlState(envValue(env, variable))));
  const list = vars.join(', ');
  if (state === 'missing') return { name, status: 'missing', detail: `set ${list}` };
  if (state === 'local' || devStack)
    return { name, status: LOCAL_FAKE, detail: `${list} must be https and non-local` };
  return { name, status: 'real', detail: list };
}

function persistence(env: Env): ProviderReport {
  const name = 'authority-persistence';
  const url = parse(env.DATABASE_URL);
  if (url === undefined) return { name, status: 'missing', detail: 'set DATABASE_URL' };
  const postgres = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  const socket = url.hostname === '' && url.searchParams.has('host');
  const local = !postgres || (!socket && isLocalHost(url.hostname));
  return local
    ? { name, status: LOCAL_FAKE, detail: 'DATABASE_URL must be a non-local PostgreSQL URL' }
    : { name, status: 'real', detail: 'DATABASE_URL' };
}

function oauth(env: Env, devStack: boolean): ProviderReport {
  const name = 'oauth-credentials';
  const vars = ['OAUTH_URL', 'OAUTH_REDIRECT_URI'];
  const base = fromUrls(name, vars, env, devStack);
  const publicUrl = env.OAUTH_PUBLIC_URL;
  if (base.status === 'real' && publicUrl !== undefined && urlState(publicUrl) !== 'real')
    return { name, status: LOCAL_FAKE, detail: 'OAUTH_PUBLIC_URL must be https and non-local' };
  return base;
}

function requiredConfig(env: Env): ProviderReport {
  const name = 'required-config';
  try {
    loadConfig(env);
    return { name, status: 'real', detail: 'loaded' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid';
    return { name, status: 'missing', detail: detail.replace(/[^\w ,:]/g, '') };
  }
}

function incident(env: Env, devStack: boolean): ProviderReport {
  const name = 'incident-ticketing';
  const vars = ['INCIDENTS_URL', 'TICKETS_URL'];
  const set = vars.filter((variable) => (envValue(env, variable) ?? '') !== '');
  if (set.length === 0)
    return { name, status: 'disabled-optional', detail: 'incident dispatch fails closed' };
  const base = fromUrls(name, vars, env, devStack);
  if (base.status !== 'real') return base;
  return {
    name,
    status: LOCAL_FAKE,
    detail: 'incident receipts and results are process-local; unset INCIDENTS_URL, TICKETS_URL',
  };
}

/** Classifies every provider the composition root depends on. Reads names only, never echoes values. */
export function classifyProviders(env: Env): readonly ProviderReport[] {
  const devStack = env.AW_DEV_STACK === '1';
  return [
    fromUrls('identity', ['IAP_JWKS_URL'], env, devStack),
    fromUrls('model', ['LLM_URL'], env, devStack),
    fromUrls('source-storage', ['DRIVE_URL', 'DIRECTORY_URL'], env, devStack),
    persistence(env),
    oauth(env, devStack),
    requiredConfig(env),
    incident(env, devStack),
  ];
}

/** Local mode keeps fakes. Production rejects every provider that is not real or explicitly optional. */
export function assertStartup(env: Env): readonly ProviderReport[] {
  const reports = classifyProviders(env);
  if (readStartupMode(env) === 'local') return reports;
  const bad = reports.filter(
    (report) => report.status === 'local-fake' || report.status === 'missing',
  );
  if (bad.length > 0) throw new ProductionStartupRejected(bad);
  return reports;
}
