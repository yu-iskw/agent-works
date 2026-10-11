import type { Route } from '../http.js';

type RouteEnvName =
  | 'AW_SEARCH'
  | 'AW_TASKS'
  | 'AW_TASKS_READ'
  | 'AW_TASKS_EVENTS'
  | 'AW_TASKS_CANCEL'
  | 'AW_APPROVALS'
  | 'AW_ARTIFACTS'
  | 'AW_SKILLS'
  | 'AW_OAUTH_CONNECT'
  | 'AW_OAUTH_REVOKE';

export type RouteEnv = Readonly<Record<string, string | undefined>>;

type SlotBase = {
  readonly id: string;
  readonly env: RouteEnvName;
  readonly method: string;
  readonly stub: Route;
  readonly real?: Route;
};

export type ExactSlot = SlotBase & {
  readonly kind: 'exact';
  readonly path: string;
};

export type PatternSlot = SlotBase & {
  readonly kind: 'pattern';
  readonly match: RegExp;
};

export type RouteSlot = ExactSlot | PatternSlot;

const realValue = 'real';

function isReal(env: RouteEnv, name: RouteEnvName): boolean {
  // eslint-disable-next-line security/detect-object-injection
  return env[name] === realValue;
}

export function selectRoute(slot: RouteSlot, env: RouteEnv): Route {
  if (isReal(env, slot.env) && slot.real !== undefined) return slot.real;
  return slot.stub;
}
