export type AgentInfo = {
  readonly id: string;
  readonly framework: 'adk';
  readonly description: string;
};

export const agents: readonly AgentInfo[] = [
  {
    id: 'ask',
    framework: 'adk',
    description: 'Answers a question from permitted Drive sources with citations.',
  },
];
