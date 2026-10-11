import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';
import { createSkillRegistry } from '../skills/registry.js';

import { notImplementedRoute } from './not-implemented.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { ExactSlot } from './slot.js';
import type { SkillRegistry } from '../skills/registry.js';

export const skillsListSlot: ExactSlot = {
  id: 'skills-list',
  env: 'AW_SKILLS',
  method: 'GET',
  path: '/v1/skills',
  kind: 'exact',
  stub: notImplementedRoute,
};

export function createSkillsListRoute(
  verify: VerifyAssertion,
  registry: SkillRegistry = createSkillRegistry(),
): Route {
  return async (request) => {
    try {
      await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      return { status: 200, body: { skills: registry.list() } };
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof Unavailable) return { status: 503, body: { error: 'unavailable' } };
      throw error;
    }
  };
}
