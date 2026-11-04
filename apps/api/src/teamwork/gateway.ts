import {
  CONNECTOR_CATALOG,
  MCP_SERVER_CATALOG,
  findMcpServer,
} from '@agent-works/domain/connector-catalog';
import { connectorToolManifests, defineConnector } from '@agent-works/domain/connector-cdk';
import {
  SOURCE_CAPABILITY,
  capabilitySchema,
  metricsScopeSchema,
  publishProposalSchema,
} from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { wrapSourceText } from '../governance/source-data.js';

import { capabilitiesFor } from './catalog.js';
import { connectedProviders, tokenSource } from './connections.js';
import { audit } from './context.js';
import { segmentCapabilities } from './installations.js';
import { McpAdapterError, connectMcp } from './mcp-adapter.js';
import { appendEvent, readTask, withTask } from './store.js';
import { publishDigest } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { McpErrorCode, McpToolPin } from './mcp-adapter.js';
import type { Published, SourceResult, TokenSource } from './sources/port.js';
import type { TaskRow } from './store.js';
import type { ConnectorRegistry } from '@agent-works/domain/connector-cdk';
import type {
  Capability,
  MetricsScope,
  PublishProposal,
  SourceKind,
} from '@agent-works/domain/teamwork';

type DenialCode =
  | 'not_found'
  | 'not_entitled'
  | 'unknown_tool'
  | 'capability_disabled'
  | 'not_permitted'
  | 'not_connected'
  | 'invalid_input'
  | 'approval_invalid'
  | 'resolution_unavailable'
  | McpErrorCode;

/** A call the gateway refused before any handler ran; `reason` is safe to show the member. */
export class GatewayDenied extends Error {
  constructor(
    readonly code: DenialCode,
    readonly reason: string,
  ) {
    super(code);
    this.name = 'GatewayDenied';
  }

  /** True when the denial says "could not decide", so the same call may succeed later. */
  get retryable(): boolean {
    return this.code === 'resolution_unavailable';
  }
}

/** Current segment membership; a failed directory lookup denies with a retryable code. */
export async function assertEntitled(deps: Deps, member: Member): Promise<void> {
  let entitled: boolean;
  try {
    entitled = deps.directory
      ? await deps.directory.isMember(member.email)
      : deps.config.members.has(member.email);
  } catch {
    throw new GatewayDenied(
      'resolution_unavailable',
      'Your membership could not be confirmed right now. Nothing was read or written; try again.',
    );
  }
  if (!entitled)
    throw new GatewayDenied('not_entitled', 'You are no longer a member of this segment.');
}

type PublishApproval = {
  readonly id: string;
  readonly proposal: PublishProposal;
  readonly idempotencyKey: string;
};

type HandlerContext = {
  readonly deps: Deps;
  readonly task: TaskRow;
  readonly token: TokenSource;
  /** Set only for a tool whose manifest requires approval, and only after the digest matched. */
  readonly approval: PublishApproval | undefined;
};

/** `untrusted` is provider-authored text; the gateway wraps each entry as source data. */
type ToolOutput = { readonly value: unknown; readonly untrusted: readonly string[] };

type ToolHandler = {
  readonly schema: z.ZodType;
  readonly run: (context: HandlerContext, input: unknown) => Promise<ToolOutput>;
};

function toolHandler<S extends z.ZodType>(
  schema: S,
  run: (context: HandlerContext, input: z.output<S>) => Promise<ToolOutput>,
): ToolHandler {
  // The gateway already parsed the input; parsing again only narrows its type for the handler.
  return { schema, run: (context, input) => run(context, schema.parse(input)) };
}

const approvalInputSchema = z.strictObject({ approvalId: z.string().min(1).max(64) });

function readInputSchema(kind: z.ZodType<SourceKind>) {
  return z.strictObject({
    kind,
    query: z.string().max(4096),
    metrics: metricsScopeSchema.nullable(),
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .max(200)
      .nullable(),
    issueNumber: z.number().int().positive().nullable(),
  });
}

/** Each read tool accepts only the source kinds its own capability covers. */
function readTool(kind: z.ZodType<SourceKind>): ToolHandler {
  return toolHandler(readInputSchema(kind), async ({ deps, token }, input) => {
    const result = await deps.sources.read({ ...input, token });
    return {
      value: result,
      untrusted: [
        ...result.items.map((item) => item.excerpt),
        ...(result.metrics === null
          ? []
          : [result.metrics.observations.excerpt, result.metrics.definitions.excerpt]),
      ],
    };
  });
}

const publishTool = toolHandler(approvalInputSchema, async ({ deps, task, token, approval }) => {
  // Fail closed: a write handler never runs without the approval the gateway verified.
  if (approval === undefined)
    throw new GatewayDenied('approval_invalid', 'This write needs an approval.');
  const { proposal } = approval;
  await deps.sql`update wb_actions set attempts = attempts + 1, updated_at = ${deps.now()} where approval_id = ${approval.id}`;
  await withTask(deps, undefined, task.id, (tx) =>
    appendEvent(deps, tx, task.id, {
      type: 'action.started',
      summary: `Creating "${proposal.documentTitle}" in ${proposal.account}`,
      detail: { mode: deps.sources.mode },
    }),
  );
  const published = await deps.sources.publish({
    token,
    idempotencyKey: approval.idempotencyKey,
    title: proposal.documentTitle,
    markdown: proposal.contentMarkdown,
  });
  return { value: { published, proposal }, untrusted: [] };
});

const notesSearchInput = z.strictObject({ query: z.string().max(200) });
const notesAppendInput = z.strictObject({ text: z.string().max(2000) });

const NOTES_MANIFEST = findMcpServer('notes');

/**
 * Pins come from the manifest, so a server advertising anything else is refused on connect. A
 * missing manifest would leave the server with no pins, so the gateway fails at load instead.
 */
const NOTES_PINS: readonly McpToolPin[] = (
  NOTES_MANIFEST === undefined ? [] : connectorToolManifests(NOTES_MANIFEST)
).map((tool) => ({ name: tool.metadata.name, sideEffect: tool.spec.sideEffect }));
if (NOTES_PINS.length === 0) throw new Error('The notes MCP manifest is missing or has no tools.');

/**
 * One MCP call. The gateway has just proven this one tool's capability effective, so only that
 * tool is enabled; every other pinned tool stays refused. A failure maps to a fixed, safe code and
 * never carries upstream text.
 */
async function callNotes(
  deps: Deps,
  tool: string,
  args: Record<string, unknown>,
): Promise<readonly string[]> {
  if (deps.mcp === undefined)
    throw new GatewayDenied('mcp_unavailable', new McpAdapterError('mcp_unavailable').message);
  try {
    const session = await connectMcp(await deps.mcp(), {
      tools: NOTES_PINS,
      enabled: new Set([tool]),
    });
    try {
      return (await session.callTool(tool, args)).texts;
    } finally {
      await session.close();
    }
  } catch (error) {
    const failure =
      error instanceof McpAdapterError ? error : new McpAdapterError('mcp_unavailable');
    throw new GatewayDenied(failure.code, failure.message);
  }
}

const notesSearchTool = toolHandler(notesSearchInput, async ({ deps }, input) => {
  const texts = await callNotes(deps, 'notes.search', input);
  return { value: { matches: texts.length }, untrusted: texts };
});

/** Fail closed: policy `mcp-write-v1` has no approval path yet, so no write handler ever runs. */
const notesAppendTool = toolHandler(notesAppendInput, () =>
  Promise.reject(new GatewayDenied('approval_invalid', 'This write needs an approval.')),
);

const HANDLERS: ReadonlyMap<string, Readonly<Record<string, ToolHandler>>> = new Map<
  string,
  Readonly<Record<string, ToolHandler>>
>([
  [
    'google',
    {
      'drive.read': readTool(z.enum(['drive_research', 'drive_context'])),
      'bigquery.query': readTool(z.literal('bigquery_metrics')),
      'docs.publish': publishTool,
    },
  ],
  ['github', { 'github.read': readTool(z.enum(['github_issue', 'github_code'])) }],
  ['notes', { 'notes.search': notesSearchTool, 'notes.append': notesAppendTool }],
]);

/** Built from the catalog manifests, so a tool without a handler (or a handler without a tool) fails at load. */
const REGISTRY: ConnectorRegistry<ToolHandler> = new Map(
  [...CONNECTOR_CATALOG, ...MCP_SERVER_CATALOG].flatMap((manifest) => [
    ...defineConnector(manifest, HANDLERS.get(manifest.id) ?? {}),
  ]),
);

type GatewayCall = {
  readonly tool: string;
  readonly input: unknown;
  readonly taskId: string;
  /** The assignment whose capability snapshot the call runs under; absent for a task-level write. */
  readonly assignmentId?: string;
  /** Lets a caller share one refreshed token across calls; defaults to the member's own. */
  readonly token?: TokenSource;
};

type GatewayResult = { readonly value: unknown; readonly data: readonly string[] };

async function requestedCapabilities(
  deps: Deps,
  task: TaskRow,
  assignmentId: string | undefined,
): Promise<readonly Capability[]> {
  if (assignmentId !== undefined) {
    const rows = await deps.sql<{ capabilities: string[] }[]>`
      select capabilities from tw_assignments where id = ${assignmentId} and task_id = ${task.id}
    `;
    const row = rows.at(0);
    if (row === undefined) throw new GatewayDenied('not_found', 'The assignment was not found.');
    return z.array(capabilitySchema).parse(row.capabilities);
  }
  const rows = await deps.sql<{ capability_requests: string[] }[]>`
    select capability_requests from tw_teammates where id = ${task.result_owner}
  `;
  return z.array(capabilitySchema).parse(rows.at(0)?.capability_requests ?? []);
}

/** The exact approved publication: same row, digest and revision, approved by this member. */
async function approvedPublication(
  deps: Deps,
  member: Member,
  task: TaskRow,
  approvalId: string,
): Promise<PublishApproval> {
  const invalid = new GatewayDenied(
    'approval_invalid',
    'The approval no longer matches the revision to publish.',
  );
  const row = (
    await deps.sql<
      {
        id: string;
        state: string;
        proposal: unknown;
        payload_sha256: string;
        subject_ref: number;
        decided_by: string | null;
        idempotency_key: string;
      }[]
    >`
    select ap.id, ap.state, ap.proposal, ap.payload_sha256, ap.subject_ref, ap.decided_by,
      ac.idempotency_key
    from wb_approvals ap join wb_actions ac on ac.approval_id = ap.id
    where ap.id = ${approvalId} and ap.task_id = ${task.id} and ap.subject = 'publish'
  `
  ).at(0);
  const proposal = publishProposalSchema.safeParse(row?.proposal);
  if (
    row === undefined ||
    task.status !== 'publishing' ||
    row.state !== 'approved' ||
    row.decided_by !== member.sub ||
    !proposal.success ||
    publishDigest(proposal.data) !== row.payload_sha256 ||
    row.subject_ref !== task.latest_revision
  )
    throw invalid;
  return { id: row.id, proposal: proposal.data, idempotencyKey: row.idempotency_key };
}

/**
 * Every source fetch and write goes through here, and every check runs again on every call: a
 * capability disabled after planning stops the next call, not the next restart. A call already
 * inside its handler finishes; nothing interrupts an upstream request in flight.
 */
export async function invoke(
  deps: Deps,
  member: Member,
  call: GatewayCall,
): Promise<GatewayResult> {
  const task = await readTask(deps.sql, member.sub, call.taskId);
  try {
    return await recheckAndRun(deps, member, task, call);
  } catch (error) {
    if (error instanceof GatewayDenied)
      await audit(deps, deps.sql, {
        ownerSub: member.sub,
        taskId: task?.id ?? null,
        action: 'gateway.denied',
        outcome: error.code,
        detail: { tool: REGISTRY.has(call.tool) ? call.tool : 'unknown' },
      });
    throw error;
  }
}

/** The segment still offers the capability, and for this member, teammate and task it is effective. */
async function assertEffective(
  deps: Deps,
  member: Member,
  task: TaskRow,
  call: GatewayCall,
  capability: Capability,
): Promise<void> {
  const [segment, requests, connected] = await Promise.all([
    segmentCapabilities(deps),
    requestedCapabilities(deps, task, call.assignmentId),
    connectedProviders(deps, member.sub),
  ]);
  if (!segment.has(capability))
    throw new GatewayDenied('capability_disabled', 'This segment has turned that capability off.');
  const states = await capabilitiesFor(deps, member, requests, new Set([capability]), {
    connected,
    segment,
  });
  const state = states.find((candidate) => candidate.capability === capability);
  if (state?.effective !== true)
    throw new GatewayDenied(
      state?.connected === false ? 'not_connected' : 'not_permitted',
      state?.reason ?? 'Not available.',
    );
}

async function recheckAndRun(
  deps: Deps,
  member: Member,
  task: TaskRow | undefined,
  call: GatewayCall,
): Promise<GatewayResult> {
  if (task === undefined) throw new GatewayDenied('not_found', 'The task was not found.');
  await assertEntitled(deps, member);
  const entry = REGISTRY.get(call.tool);
  if (entry === undefined) throw new GatewayDenied('unknown_tool', 'That tool is not available.');
  await assertEffective(
    deps,
    member,
    task,
    call,
    capabilitySchema.parse(entry.manifest.spec.permissions.workloadCapability),
  );
  const parsed = entry.handler.schema.safeParse(call.input);
  if (!parsed.success)
    throw new GatewayDenied('invalid_input', 'The tool input did not match its schema.');
  const { approval } = entry.manifest.spec;
  if (approval.required && approval.policy !== 'segment-publish-v1')
    throw new GatewayDenied('approval_invalid', 'No approval policy applies to this write.');
  const output = await entry.handler.run(
    {
      deps,
      task,
      token: call.token ?? tokenSource(deps, member.sub),
      approval: approval.required
        ? await approvedPublication(
            deps,
            member,
            task,
            approvalInputSchema.parse(parsed.data).approvalId,
          )
        : undefined,
    },
    parsed.data,
  );
  return { value: output.value, data: output.untrusted.map(wrapSourceText) };
}

type ReadCall = Omit<GatewayCall, 'tool' | 'input' | 'assignmentId'> & {
  readonly assignmentId: string;
  readonly input: {
    readonly kind: Exclude<SourceKind, 'member_file'>;
    readonly query: string;
    readonly metrics: MetricsScope | null;
    readonly repository: string | null;
    readonly issueNumber: number | null;
  };
};

/** One source fetch for an assignment; `data` is the provider text wrapped as untrusted source data. */
export async function readThroughGateway(
  deps: Deps,
  member: Member,
  call: ReadCall,
): Promise<{ readonly result: SourceResult; readonly data: readonly string[] }> {
  const tool = SOURCE_CAPABILITY[call.input.kind];
  const { value, data } = await invoke(deps, member, { ...call, tool });
  return { result: value as SourceResult, data };
}

/** Publishes the approved Google Doc; returns what was written together with the approved proposal. */
export async function publishThroughGateway(
  deps: Deps,
  member: Member,
  call: Pick<GatewayCall, 'taskId' | 'token'> & { readonly approvalId: string },
): Promise<{ readonly published: Published; readonly proposal: PublishProposal }> {
  const { value } = await invoke(deps, member, {
    tool: 'docs.publish',
    taskId: call.taskId,
    token: call.token,
    input: { approvalId: call.approvalId },
  });
  return value as { published: Published; proposal: PublishProposal };
}
