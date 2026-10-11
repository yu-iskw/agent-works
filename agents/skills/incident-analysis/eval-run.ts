import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerLimitsSchema, skillManifestSchema } from '@agent-works/domain';
import { createIncidents, createTicket, listen } from '@agent-works/fakes';

import { createAdkRunner } from '../../../apps/api/src/agent/adk-runner.js';

import { deliverIncident } from './deliver.js';
import { createSkillLlm } from './skill-llm.js';

import type { Delivery, IncidentModel, SkillPackage } from './deliver.js';
import type { SkillManifest } from '@agent-works/domain';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const deliveryId = 'delivery-1';
const incidentId = 'inc-1';
const ticketProject = 'incidents';
const summary = 'Checkout latency after dep-9';

const skillLlm = createSkillLlm();
const publishedSkill = loadSkill();
const runnerLimits = runnerLimitsSchema.parse({
  maxSteps: 4,
  maxToolCalls: 4,
  maxCostUsd: 1,
  maxElapsedMs: 1000,
  maxBytesRetrieved: 10,
  maxGeneratedOutputs: 1,
  maxModelRetries: 1,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
});

type Ticket = {
  readonly id: string;
  readonly summary: string;
  readonly project: string;
  readonly idempotencyKey: string;
};

type Stack = {
  readonly skill: SkillPackage;
  readonly model: IncidentModel;
  readonly incidentsUrl: string;
  readonly ticketsUrl: string;
  readonly close: () => Promise<void>;
};

export async function duplicateDelivery(): Promise<{
  first: Delivery;
  second: Delivery;
  tickets: readonly Ticket[];
}> {
  return withStack(0, async (stack) => {
    const ledger = new Map<string, string>();
    const first = await deliverIncident(inputFor(stack, ledger, 1000));
    const second = await deliverIncident(inputFor(stack, ledger, 1000));
    return { first, second, tickets: await listTickets(stack.ticketsUrl) };
  });
}

export async function timeoutAfterWrite(): Promise<{
  first: Delivery;
  second: Delivery;
  tickets: readonly Ticket[];
}> {
  return withStack(300, async (stack) => {
    const ledger = new Map<string, string>();
    const first = await deliverIncident(inputFor(stack, ledger, 40));
    const second = await deliverIncident(inputFor(stack, ledger, 1000));
    return { first, second, tickets: await listTickets(stack.ticketsUrl) };
  });
}

export async function revokedSkill(): Promise<{
  revoked: Delivery;
  ticketsAfterRevoke: readonly Ticket[];
  published: Delivery;
}> {
  return withStack(0, async (stack) => {
    const revoked = await deliverIncident({
      ...inputFor(stack, new Map(), 1000),
      skill: skillWith('REVOKED'),
    });
    const ticketsAfterRevoke = await listTickets(stack.ticketsUrl);
    const published = await deliverIncident(inputFor(stack, new Map(), 1000));
    return { revoked, ticketsAfterRevoke, published };
  });
}

export async function runEval(write: (line: string) => void): Promise<string> {
  const names = loadCases();
  let passed = 0;
  for (const name of names) {
    if (await casePassed(name)) passed += 1;
  }
  const line = `score ${passed}/${names.length}`;
  write(line);
  return line;
}

async function casePassed(name: string): Promise<boolean> {
  switch (name) {
    case 'duplicate-delivery':
      return duplicatePassed(await duplicateDelivery());
    case 'timeout-after-write':
      return timeoutPassed(await timeoutAfterWrite());
    case 'revoked-skill':
      return revokedPassed(await revokedSkill());
    default:
      return false;
  }
}

function duplicatePassed(result: {
  first: Delivery;
  second: Delivery;
  tickets: readonly Ticket[];
}): boolean {
  return (
    result.first.kind === 'written' &&
    result.second.kind === 'written' &&
    result.first.ticketId === result.second.ticketId &&
    result.tickets.length === 1 &&
    result.tickets[0]?.id === result.first.ticketId &&
    result.tickets[0]?.summary === summary &&
    result.tickets[0]?.project === ticketProject &&
    result.tickets[0]?.idempotencyKey === deliveryId
  );
}

function timeoutPassed(result: {
  first: Delivery;
  second: Delivery;
  tickets: readonly Ticket[];
}): boolean {
  return (
    result.first.kind === 'timeout' &&
    result.second.kind === 'written' &&
    result.tickets.length === 1 &&
    result.tickets[0]?.id === result.second.ticketId &&
    result.tickets[0]?.idempotencyKey === deliveryId
  );
}

function revokedPassed(result: {
  revoked: Delivery;
  ticketsAfterRevoke: readonly Ticket[];
  published: Delivery;
}): boolean {
  return (
    result.revoked.kind === 'revoked' &&
    result.ticketsAfterRevoke.length === 0 &&
    result.published.kind === 'written' &&
    result.published.ticketId === 'FAKE-1'
  );
}

function inputFor(stack: Stack, ledger: Map<string, string>, timeoutMs: number) {
  return {
    skill: stack.skill,
    deliveryId,
    incidentId,
    incidentsUrl: stack.incidentsUrl,
    ticketsUrl: stack.ticketsUrl,
    model: stack.model,
    timeoutMs,
    ledger,
  };
}

async function withStack<T>(delayMs: number, run: (stack: Stack) => Promise<T>): Promise<T> {
  const stack = await startStack(delayMs);
  try {
    return await run(stack);
  } finally {
    await stack.close();
  }
}

async function startStack(delayMs = 0): Promise<Stack> {
  const tickets = createTicket();
  const [incidents, ticketServer, llm] = await Promise.all([
    listen(createIncidents(), 0),
    listen(delayAfterWrite(tickets, delayMs), 0),
    listen(skillLlm, 0),
  ]);
  const runner = createAdkRunner({
    baseUrl: llm.url,
    limits: runnerLimits,
  });
  return {
    skill: publishedSkill,
    model: {
      async answer(question) {
        const output = await runner.run({ question, sources: [] });
        return output.answer;
      },
    },
    incidentsUrl: incidents.url,
    ticketsUrl: ticketServer.url,
    close: async () => {
      await Promise.all([incidents.close(), ticketServer.close(), llm.close()]);
    },
  };
}

function delayAfterWrite(
  inner: ReturnType<typeof createTicket>,
  delayMs: number,
): ReturnType<typeof createTicket> {
  let arm = delayMs > 0;
  return async (request) => {
    const reply = await inner(request);
    if (arm && request.method === 'POST' && request.url.pathname === '/tickets') {
      arm = false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return reply;
  };
}

function loadSkill(): SkillPackage {
  const manifest = skillManifestSchema.parse(
    JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8')) as unknown,
  );
  const prompt = readFileSync(resolve(packageRoot, 'prompts/analyze.md'), 'utf8');
  return { manifest, prompt };
}

function skillWith(state: SkillManifest['state']): SkillPackage {
  return { manifest: { ...publishedSkill.manifest, state }, prompt: publishedSkill.prompt };
}

function loadCases(): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(resolve(packageRoot, 'eval/cases.json'), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('cases');
  const names: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') throw new Error('cases');
    names.push(item);
  }
  return names;
}

async function listTickets(url: string): Promise<readonly Ticket[]> {
  const response = await fetch(new URL('/tickets', url));
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.tickets)) throw new Error('tickets');
  return body.tickets.filter((item): item is Ticket => isTicket(item));
}

function isTicket(value: unknown): value is Ticket {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.project === 'string' &&
    typeof value.idempotencyKey === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
