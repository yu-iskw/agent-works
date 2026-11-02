import { LogLevel, setLogger } from '@google/adk';

import type { Logger } from '@google/adk';

type Sink = { write(body: string): unknown };

const labels = new Map([
  [LogLevel.DEBUG, 'DEBUG'],
  [LogLevel.INFO, 'INFO'],
  [LogLevel.WARN, 'WARN'],
  [LogLevel.ERROR, 'ERROR'],
]);

/** ADK's Node logger writes to stdout; this keeps stdout free for a command's own output. */
export function routeAdkLogsTo(sink: Sink): void {
  let threshold = LogLevel.INFO;
  const log = (level: LogLevel, ...messages: unknown[]): void => {
    if (level < threshold) return;
    sink.write(`${labels.get(level)}: [ADK] ${new Date().toISOString()} ${messages.join(' ')}\n`);
  };
  const logger: Logger = {
    log,
    debug: (...messages) => log(LogLevel.DEBUG, ...messages),
    info: (...messages) => log(LogLevel.INFO, ...messages),
    warn: (...messages) => log(LogLevel.WARN, ...messages),
    error: (...messages) => log(LogLevel.ERROR, ...messages),
    setLogLevel: (level) => {
      threshold = level;
    },
  };
  setLogger(logger);
}
