import type { EventTrigger } from '../../../../packages/domain/dist/event-trigger.js';
import type { ScheduleSpec } from '../../../../packages/domain/dist/schedule.js';
type OfflineCloudResult = {
  kind: 'offline';
  provider: 'cloud-scheduler' | 'pubsub' | 'eventarc';
  resourceId: string;
};
export interface CloudScheduleAdapter {
  register(spec: ScheduleSpec): Promise<OfflineCloudResult>;
  remove(id: string): Promise<OfflineCloudResult>;
}
export interface CloudEventAdapter {
  register(trigger: EventTrigger): Promise<OfflineCloudResult>;
  remove(id: string): Promise<OfflineCloudResult>;
}
/** Typed planning stubs. Never acquire cloud credentials or perform network calls. */
export function offlineCloudScheduler(): CloudScheduleAdapter {
  return {
    register: (spec) =>
      Promise.resolve({ kind: 'offline', provider: 'cloud-scheduler', resourceId: spec.id }),
    remove: (id) =>
      Promise.resolve({ kind: 'offline', provider: 'cloud-scheduler', resourceId: id }),
  };
}
export function offlineCloudEvents(provider: 'pubsub' | 'eventarc'): CloudEventAdapter {
  return {
    register: (trigger) => Promise.resolve({ kind: 'offline', provider, resourceId: trigger.id }),
    remove: (id) => Promise.resolve({ kind: 'offline', provider, resourceId: id }),
  };
}
