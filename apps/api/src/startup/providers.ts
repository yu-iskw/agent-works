import { WiringConfigError, readWiring } from '../composition/flags.js';
import { loadConfig } from '../config.js';

type StartupMode = 'production' | 'local';

type ProviderName =
  | 'identity'
  | 'model'
  | 'source-storage'
  | 'authority-persistence'
  | 'oauth-credentials'
  | 'required-config'
  | 'incident-ticketing'
  | 'wiring-config'
  | 'worker-delivery'
  | 'dispatch-queue';

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

function hasValue(env: Env, name: string): boolean {
  const value = envValue(env, name);
  return value !== undefined && value.trim() !== '';
}

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

/**
 * The redirect may be the loopback callback reached through `gcloud run services proxy`.
 * Only plain http on localhost or 127.0.0.1 is admitted here; every other redirect needs https and a non-local host.
 */
function redirectState(value: string | undefined): UrlState {
  const url = parse(value);
  if (url?.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    return 'real';
  return urlState(value);
}

function oauth(env: Env, devStack: boolean): ProviderReport {
  const name = 'oauth-credentials';
  const list = 'OAUTH_URL, OAUTH_REDIRECT_URI';
  const state = combine([
    urlState(envValue(env, 'OAUTH_URL')),
    redirectState(envValue(env, 'OAUTH_REDIRECT_URI')),
  ]);
  let base: ProviderReport;
  if (state === 'missing') base = { name, status: 'missing', detail: `set ${list}` };
  else if (state === 'local' || devStack)
    base = { name, status: LOCAL_FAKE, detail: `${list} must be https and non-local` };
  else if (!hasValue(env, 'GOOGLE_OAUTH_CLIENT_ID') || !hasValue(env, 'OAUTH_HOSTED_DOMAIN'))
    base = { name, status: 'missing', detail: 'set GOOGLE_OAUTH_CLIENT_ID, OAUTH_HOSTED_DOMAIN' };
  else base = { name, status: 'real', detail: list };
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

const WIRING_FLAGS = [
  'AW_TELEMETRY',
  'AW_ADMISSION',
  'AW_WORKER_DELIVERY',
  'AW_OUTBOX_PUBLISHER',
  'AW_EXECUTION_WORKER',
  'AW_EXECUTION_SWEEPER',
  'AW_OPS_DASHBOARD',
  'AW_STRICT_PROPOSALS',
  'AW_STANDING_GRANTS',
];

/** Reports only for capabilities that are switched on, so a default deployment sees no new entries. */
function wiring(env: Env): readonly ProviderReport[] {
  if (!WIRING_FLAGS.some((flag) => envValue(env, flag) === 'on')) return [];
  const name = 'wiring-config';
  try {
    const parsed = readWiring(env);
    const reports: ProviderReport[] = [{ name, status: 'real', detail: 'loaded' }];
    if (parsed.delivery !== undefined)
      reports.push(fromUrls('worker-delivery', ['AW_WORKER_URL'], env, false));
    if (parsed.outbox !== undefined)
      reports.push(fromUrls('dispatch-queue', ['AW_WORKER_URL'], env, false));
    return reports;
  } catch (error) {
    if (!(error instanceof WiringConfigError)) throw error;
    return [
      { name, status: 'missing', detail: error.problems.join(', ').replace(/[^\w ,:/]/g, '') },
    ];
  }
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
    ...wiring(env),
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
