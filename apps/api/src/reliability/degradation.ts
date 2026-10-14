export type Dependency = 'model' | 'search' | 'write_broker' | 'memory';
export type Degradation = {
  readonly outcome:
    'unavailable' | 'deny_write' | 'ungrounded' | 'without_memory' | 'approved_fallback';
  readonly model: string | null;
  readonly disclose: string;
};
/** L5 suspension remains owned by bundle 2. This module never flips a switch. */
export function degradation(input: {
  dependency: Dependency;
  approvedFallbackModel?: string;
  fallbackApproved: boolean;
}): Degradation {
  switch (input.dependency) {
    case 'model':
      return input.fallbackApproved && input.approvedFallbackModel !== undefined
        ? {
            outcome: 'approved_fallback',
            model: input.approvedFallbackModel,
            disclose: 'Using an explicitly approved fallback model.',
          }
        : {
            outcome: 'unavailable',
            model: null,
            disclose: 'Model unavailable; no unapproved model substituted.',
          };
    case 'search':
      return {
        outcome: 'ungrounded',
        model: null,
        disclose: 'Search unavailable; a grounded answer cannot be supplied.',
      };
    case 'write_broker':
      return {
        outcome: 'deny_write',
        model: null,
        disclose: 'Write broker unavailable; external writes are denied.',
      };
    case 'memory':
      return {
        outcome: 'without_memory',
        model: null,
        disclose: 'Memory unavailable; continuing without personalization if safe.',
      };
    default: {
      const unexpected: never = input.dependency;
      return unexpected;
    }
  }
}
