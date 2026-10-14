import { beforeEach, describe } from 'vitest';

import { analyticsPortContract } from '../analytics.contract.js';

import { createMemoryAnalyticsPort } from './analytics.js';

import type { AnalyticsPort } from '../analytics.js';
let port: AnalyticsPort;
beforeEach(() => {
  port = createMemoryAnalyticsPort();
});
describe('memory analytics', () => {
  analyticsPortContract(() => port);
});
