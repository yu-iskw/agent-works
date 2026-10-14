import type { BudgetEvent } from './budget-port.js';

export type ShowbackRow = {
  readonly sponsor: string;
  readonly tasks: number;
  readonly estimatedCostMicros: number;
  readonly inferenceSteps: number;
};
/** Event amounts are integer micro-units. Re-delivery does not increase showback. */
export function showback(events: readonly BudgetEvent[]): readonly ShowbackRow[] {
  const unique = new Map<string, BudgetEvent>();
  for (const event of events) {
    const prior = unique.get(event.eventId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(event))
      throw new Error('showback event conflict');
    unique.set(event.eventId, event);
  }
  const groups = new Map<string, { tasks: Set<string>; cost: number; steps: number }>();
  for (const event of unique.values()) {
    if (event.kind === 'released') continue;
    const group = groups.get(event.scope.sponsor) ?? {
      tasks: new Set<string>(),
      cost: 0,
      steps: 0,
    };
    group.tasks.add(event.scope.taskId);
    group.cost += event.estimatedCostMicros;
    group.steps += event.inferenceSteps;
    if (!Number.isSafeInteger(group.cost) || !Number.isSafeInteger(group.steps))
      throw new RangeError('showback overflow');
    groups.set(event.scope.sponsor, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([sponsor, group]) => ({
      sponsor,
      tasks: group.tasks.size,
      estimatedCostMicros: group.cost,
      inferenceSteps: group.steps,
    }));
}
