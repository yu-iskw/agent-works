import { describe, expect, it } from 'vitest';

import { authoritySubset } from '../../../../packages/domain/dist/delegation-authority.js';

import { childContext } from './context.js';
import { fixtureChild, fixtureContext, fixtureNow } from './fixtures.js';
describe('explicit child context', () => {
  it('binds root scope, trace, depth and computed authority', () => {
    const child = childContext(fixtureContext, fixtureChild, 2, fixtureNow);
    expect(child).toMatchObject({
      parentTaskId: 'parent',
      rootTaskId: 'parent',
      traceId: 'trace-1',
      depth: 1,
      budgetScope: fixtureContext.budgetScope,
    });
    expect(authoritySubset(child.authority, fixtureContext.authority)).toBe(true);
    expect(child.authority.grants).toEqual([{ capability: 'drive.read', resource: 'source-1' }]);
  });
  it('enforces the depth limit on grandchildren', () => {
    const child = childContext(fixtureContext, fixtureChild, 1, fixtureNow);
    expect(() =>
      childContext(child, { ...fixtureChild, childTaskId: 'grandchild' }, 1, fixtureNow),
    ).toThrow('depth');
  });
  it.each([-1, 0, NaN, 1.5])('rejects invalid depth ceiling %s', (limit) => {
    expect(() => childContext(fixtureContext, fixtureChild, limit, fixtureNow)).toThrow('depth');
  });
  it('rejects expired parent authority', () => {
    expect(() =>
      childContext(
        {
          ...fixtureContext,
          authority: { ...fixtureContext.authority, expiresAt: fixtureNow.toISOString() },
        },
        fixtureChild,
        2,
        fixtureNow,
      ),
    ).toThrow('expired');
  });
  it.each(['estimatedCostMicros', 'inferenceSteps', 'parallelism'] as const)(
    'rejects an enlarged %s share',
    (dimension) => {
      // dimension is one of the three literal numeric budget fields listed above.
      const share = {
        ...fixtureChild.budgetShare,
        // eslint-disable-next-line security/detect-object-injection
        [dimension]: fixtureContext.budgetShare[dimension] + 1,
      };
      expect(() =>
        childContext(fixtureContext, { ...fixtureChild, budgetShare: share }, 2, fixtureNow),
      ).toThrow('budget_share');
    },
  );
  it('rejects reassignment of the root budget subject', () => {
    expect(() =>
      childContext(
        { ...fixtureContext, budgetScope: { ...fixtureContext.budgetScope, userSubject: 'bob' } },
        fixtureChild,
        2,
        fixtureNow,
      ),
    ).toThrow('identity');
  });
});
