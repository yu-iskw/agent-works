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

const real = 'real';

function isReal(env: RouteEnv, name: RouteEnvName): boolean {
  switch (name) {
    case 'AW_SEARCH':
      return env.AW_SEARCH === real;
    case 'AW_TASKS':
      return env.AW_TASKS === real;
    case 'AW_TASKS_READ':
      return env.AW_TASKS_READ === real;
    case 'AW_TASKS_EVENTS':
      return env.AW_TASKS_EVENTS === real;
    case 'AW_TASKS_CANCEL':
      return env.AW_TASKS_CANCEL === real;
    case 'AW_APPROVALS':
      return env.AW_APPROVALS === real;
    case 'AW_ARTIFACTS':
      return env.AW_ARTIFACTS === real;
    case 'AW_SKILLS':
      return env.AW_SKILLS === real;
    case 'AW_OAUTH_CONNECT':
      return env.AW_OAUTH_CONNECT === real;
    case 'AW_OAUTH_REVOKE':
      return env.AW_OAUTH_REVOKE === real;
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

export function selectRoute(slot: RouteSlot, env: RouteEnv): Route {
  if (isReal(env, slot.env) && slot.real !== undefined) return slot.real;
  return slot.stub;
}
