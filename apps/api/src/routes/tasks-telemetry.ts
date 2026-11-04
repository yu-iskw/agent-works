import { headerValue } from '../http.js';

import type { ApiReply, Route } from '../http.js';
import type { TaskRoutes } from './tasks.js';
import type { Telemetry } from '../telemetry/instrument.js';

const taskPath = /^\/v1\/tasks\/([^/:]+)/;
const routeLabels: Readonly<Record<keyof Omit<TaskRoutes, 'cancel'> | 'cancel', string>> = {
  submit: 'task.submit',
  read: 'task.read',
  events: 'task.events',
  cancel: 'task.cancel',
};

/**
 * Spans every task route. The wrapper runs the route first and returns its reply untouched, so
 * telemetry can neither change an authorization outcome nor invent a successful one.
 */
export function instrumentTaskRoutes(routes: TaskRoutes, telemetry: Telemetry): TaskRoutes {
  const wrap = (name: keyof typeof routeLabels, route: Route): Route => {
    // eslint-disable-next-line security/detect-object-injection -- key comes from a closed union
    const label = routeLabels[name];
    return (request) =>
      telemetry.span(
        label,
        {
          traceparent: headerValue(request.headers, 'traceparent'),
          correlation: {
            request: headerValue(request.headers, 'x-request-id'),
            task: taskPath.exec(request.path)?.[1],
          },
          metric: { name: 'task_route_requests_total', labels: { route: label } },
        },
        async (span) => {
          const reply = await route(request);
          span.attribute('http_status', reply.status);
          span.correlate({ task: replyTaskId(reply) });
          if (reply.status === 401 || reply.status === 403) span.status('denied');
          return reply;
        },
      );
  };
  return {
    submit: wrap('submit', routes.submit),
    read: wrap('read', routes.read),
    events: wrap('events', routes.events),
    ...(routes.cancel === undefined ? {} : { cancel: wrap('cancel', routes.cancel) }),
  };
}

function replyTaskId(reply: ApiReply): string | undefined {
  if (typeof reply.body !== 'object' || reply.body === null) return undefined;
  const { taskId, id } = reply.body as { taskId?: unknown; id?: unknown };
  const found = taskId ?? id;
  return typeof found === 'string' ? found : undefined;
}
