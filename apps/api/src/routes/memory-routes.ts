import { memoryChangeRoutes } from './memory-change.js';
import { memoryConsentRoutes } from './memory-consent.js';
import { memoryReadRoutes } from './memory-read.js';

import type { MemoryRouteDeps } from './memory-auth.js';
import type { Route } from '../http.js';
export function memoryRoutes(deps: MemoryRouteDeps | undefined): Readonly<Record<string, Route>> {
  return deps === undefined
    ? {}
    : { ...memoryConsentRoutes(deps), ...memoryReadRoutes(deps), ...memoryChangeRoutes(deps) };
}
