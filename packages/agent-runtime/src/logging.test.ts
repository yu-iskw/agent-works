import { logger, resetLogger } from '@google/adk';
import { afterEach, expect, it, vi } from 'vitest';

import { routeAdkLogsTo } from './logging.js';

afterEach(() => {
  resetLogger();
  vi.restoreAllMocks();
});

it('writes ADK log lines to the given sink and nothing to stdout or the console', () => {
  const stdout = vi.spyOn(process.stdout, 'write');
  const consoleInfo = vi.spyOn(console, 'info');
  const lines: string[] = [];
  routeAdkLogsTo({ write: (body) => lines.push(body) });
  logger.info('Sending out request,', 'model: m');
  logger.debug('below the default threshold');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^INFO: \[ADK\] \S+ Sending out request, model: m\n$/);
  expect(stdout).not.toHaveBeenCalled();
  expect(consoleInfo).not.toHaveBeenCalled();
});
