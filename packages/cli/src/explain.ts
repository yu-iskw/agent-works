import { readFileSync } from 'node:fs';

import { decide, parseFacts } from '@agent-works/policy';

import { ApiClient } from '../../api-contract/dist/client.generated.js';
import { ApiClientError } from '../../api-contract/dist/transport.js';

import type { TaskSubmit } from '../../api-contract/dist/client.generated.js';
import type { ClientOptions } from '../../api-contract/dist/transport.js';

type PolicyDecision = ReturnType<typeof decide>;

function readFixture(value: unknown): ReturnType<typeof parseFacts> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixture must be an object');
  }
  const entries = Object.entries(value) as [string, unknown][];
  let modelText: unknown;
  let facts: unknown;
  let sawFacts = false;
  for (const [key, bit] of entries) {
    if (key === 'facts') {
      facts = bit;
      sawFacts = true;
      continue;
    }
    if (key === 'modelText') {
      modelText = bit;
      continue;
    }
    throw new Error('unknown fixture field');
  }
  if (!sawFacts) throw new Error('fixture needs facts');
  if (modelText !== undefined && typeof modelText !== 'string') {
    throw new Error('modelText must be a string');
  }
  return parseFacts(facts);
}

export function explainDecision(decision: PolicyDecision): string {
  switch (decision.effect) {
    case 'allow':
      return 'ALLOW\n';
    case 'deny':
      return `DENY ${decision.failedClauses.join(' ')}\n`;
    default: {
      const unexpected: never = decision;
      throw new Error(unexpected);
    }
  }
}

export function explainFixture(value: unknown): string {
  return explainDecision(decide({ facts: readFixture(value) }));
}

async function taskCommand(client: ApiClient, argv: readonly string[]): Promise<unknown> {
  const action = argv[3];
  const id = argv[4];
  if (action === 'read' && argv.length === 5) return client.readTask(id);
  if (action === 'events' && argv.length === 5) return client.taskEvents(id);
  if (action === 'cancel' && argv.length === 6)
    return client.cancelTask(id, { 'idempotency-key': argv[5] });
  if (action === 'submit' && argv.length === 6) {
    // The generated transport validates this untrusted file before dispatch.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const body = JSON.parse(readFileSync(id, 'utf8')) as TaskSubmit;
    return client.submitTask(body, { 'idempotency-key': argv[5] });
  }
  throw new Error('invalid task command');
}
async function approvalCommand(client: ApiClient, argv: readonly string[]): Promise<unknown> {
  const id = argv[4];
  const action = argv[3];
  if (action === 'read' && argv.length === 5) return client.readApproval(id);
  if (action === 'decide' && argv.length === 8 && (argv[5] === 'approve' || argv[5] === 'reject')) {
    return client.decideApproval(
      id,
      { kind: 'decide', decision: argv[5], expectedPayloadSha256: argv[6] },
      { 'x-csrf-token': argv[7] },
    );
  }
  throw new Error('invalid approval command');
}
/** Task and approval commands use the generated contract for request/response validation. */
export async function runApiCommand(
  argv: readonly string[],
  stdout: { write(data: string): void },
  options: ClientOptions,
): Promise<number> {
  try {
    if (argv.length < 5) return 1;
    const client = new ApiClient(options);
    let result: unknown;
    switch (argv[2]) {
      case 'tasks':
        result = await taskCommand(client, argv);
        break;
      case 'approvals':
        result = await approvalCommand(client, argv);
        break;
      default:
        return 1;
    }
    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    if (error instanceof ApiClientError) stdout.write(`ERROR ${error.status} ${error.code}\n`);
    return 1;
  }
}
