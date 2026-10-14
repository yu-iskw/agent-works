export { POLICY_VERSION, decide, whenAllowed } from './decide.js';
export { parseFacts } from './facts.js';

export type { PolicyFacts, PolicyInput } from './decide.js';
export { suspensionDecision, suspensionFacts } from './suspension.js';
export type { InvocationContext, SuspensionDenial, SuspensionFacts } from './suspension.js';
