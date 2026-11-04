import { describe, expect, it } from 'vitest';

import {
  BOT_RUN_TERMINAL,
  BOT_RUN_TRANSITIONS,
  BOT_STEP_TERMINAL,
  BOT_STEP_TRANSITIONS,
  botRunStatusSchema,
  botStepStatusSchema,
  canTransition,
} from './bot-run.js';

describe('durable bot state machines', () => {
  it('pins every allowed run transition', () => {
    const transitions = new Map(Object.entries(BOT_RUN_TRANSITIONS));
    expect(BOT_RUN_TRANSITIONS).toEqual({
      queued: ['waiting_approval', 'running', 'failed', 'cancel_requested', 'cancelled'],
      waiting_approval: ['running', 'failed', 'cancel_requested', 'cancelled'],
      running: [
        'waiting_approval',
        'waiting_external',
        'completed',
        'failed',
        'cancel_requested',
        'outcome_uncertain',
      ],
      waiting_external: ['running', 'failed', 'cancel_requested', 'outcome_uncertain'],
      cancel_requested: ['cancelled', 'outcome_uncertain'],
      completed: [],
      failed: [],
      cancelled: [],
      outcome_uncertain: [],
    });
    for (const from of botRunStatusSchema.options)
      for (const to of botRunStatusSchema.options)
        expect(canTransition('run', from, to)).toBe(transitions.get(from)?.includes(to) ?? false);
    expect([...BOT_RUN_TERMINAL]).toEqual([
      'completed',
      'failed',
      'cancelled',
      'outcome_uncertain',
    ]);
    for (const state of BOT_RUN_TERMINAL) expect(transitions.get(state)).toEqual([]);
  });
  it('pins every allowed step transition and prevents late result resurrection', () => {
    const transitions = new Map(Object.entries(BOT_STEP_TRANSITIONS));
    expect(BOT_STEP_TRANSITIONS).toEqual({
      pending: ['ready', 'cancelled', 'blocked'],
      ready: ['running', 'waiting_approval', 'cancelled', 'blocked'],
      running: [
        'waiting_external',
        'waiting_approval',
        'succeeded',
        'failed',
        'cancelled',
        'outcome_uncertain',
      ],
      waiting_external: ['running', 'succeeded', 'failed', 'cancelled', 'outcome_uncertain'],
      waiting_approval: ['ready', 'running', 'failed', 'cancelled', 'blocked'],
      succeeded: [],
      failed: [],
      cancelled: [],
      outcome_uncertain: [],
      blocked: [],
    });
    for (const from of botStepStatusSchema.options)
      for (const to of botStepStatusSchema.options)
        expect(canTransition('step', from, to)).toBe(transitions.get(from)?.includes(to) ?? false);
    expect([...BOT_STEP_TERMINAL]).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'outcome_uncertain',
      'blocked',
    ]);
    for (const state of BOT_STEP_TERMINAL) expect(transitions.get(state)).toEqual([]);
  });
});
