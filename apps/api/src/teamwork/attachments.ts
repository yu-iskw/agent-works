import { createHash } from 'node:crypto';

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PREVIEW_CHARS,
  attachmentMediaTypeSchema,
} from '@agent-works/domain/teamwork';

import { Conflict, audit } from './context.js';

import type { Deps, Member, Tx } from './context.js';
import type { SourceItem } from './sources/port.js';
import type {
  AttachmentMediaType,
  AttachmentRef,
  AttachmentUpload,
  AttachmentView,
} from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

type Db = postgres.Sql | Tx;

type AttachmentRow = {
  id: string;
  owner_sub: string;
  conversation_id: string;
  name: string;
  media_type: AttachmentMediaType;
  size_bytes: number;
  sha256: string;
  text: string;
  created_at: Date;
  removed_at: Date | null;
};

/** Bytes of one evidence passage; split on line boundaries so a citation names whole lines. */
const PASSAGE_MAX_BYTES = 2048;

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const refuse = (code: string, detail: string): Conflict => new Conflict(code, 400, detail);

// ---------------------------------------------------------------------------------------------
// Validation: the upload boundary. Content is parsed to check its shape and never executed.

function checkName(name: string): void {
  const bad = [...name].some(
    (char) => char === '/' || char === '\\' || (char.codePointAt(0) ?? 0) < 32 || char === '\u007F',
  );
  if (bad)
    throw refuse(
      'attachment_name_invalid',
      'The file name may not contain path separators or control characters.',
    );
}

function checkMediaType(mediaType: string): AttachmentMediaType {
  const parsed = attachmentMediaTypeSchema.safeParse(mediaType.split(';')[0]?.trim().toLowerCase());
  if (parsed.success) return parsed.data;
  const named = mediaType === 'application/pdf' ? 'PDF' : `"${mediaType}"`;
  throw refuse(
    'unsupported_media_type',
    `${named} is not supported yet; paste the text or upload a .txt, .md, .csv or .json file.`,
  );
}

function checkText(text: string): void {
  if (text.includes('\u0000'))
    throw refuse(
      'attachment_not_text',
      'The file contains NUL bytes; only plain text is accepted.',
    );
  if (Buffer.from(text, 'utf8').toString('utf8') !== text)
    throw refuse('attachment_not_text', 'The file is not valid UTF-8 text.');
  if (text.trim().length === 0) throw refuse('attachment_empty', 'The file has no text.');
  const size = bytes(text);
  if (size > ATTACHMENT_MAX_BYTES)
    throw refuse(
      'attachment_too_large',
      `The file holds ${Math.ceil(size / 1024)} KB of text; the limit is ${ATTACHMENT_MAX_BYTES / 1024} KB.`,
    );
}

function checkJson(text: string): void {
  try {
    JSON.parse(text);
  } catch (error) {
    const why = error instanceof Error ? error.message : 'parse error';
    throw refuse('attachment_invalid_json', `The file is not valid JSON: ${why}.`);
  }
}

function csvColumns(line: string): number {
  let columns = 1;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) columns += 1;
  }
  return columns;
}

/** A cheap shape check: a header of two or more columns and every row with the same count. */
function checkCsv(text: string): void {
  const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = csvColumns(rows.at(0) ?? '');
  if (rows.length < 2 || header < 2)
    throw refuse(
      'attachment_invalid_csv',
      'A CSV needs a header row with at least two columns and one data row.',
    );
  const bad = rows.findIndex((row) => csvColumns(row) !== header);
  if (bad !== -1)
    throw refuse(
      'attachment_invalid_csv',
      `Row ${bad + 1} has ${csvColumns(rows.at(bad) ?? '')} columns; the header has ${header}.`,
    );
}

const CONTENT_CHECKS: Record<AttachmentMediaType, (text: string) => void> = {
  'text/plain': () => undefined,
  'text/markdown': () => undefined,
  'text/csv': checkCsv,
  'application/json': checkJson,
};

type ValidAttachment = {
  readonly name: string;
  readonly mediaType: AttachmentMediaType;
  readonly text: string;
  readonly sizeBytes: number;
  readonly sha256: string;
};

/** Refuses with a stable code and a member-facing detail; returns what the row will hold. */
function validateAttachment(input: AttachmentUpload): ValidAttachment {
  checkName(input.name);
  const mediaType = checkMediaType(input.mediaType);
  checkText(input.text);
  // eslint-disable-next-line security/detect-object-injection
  CONTENT_CHECKS[mediaType](input.text);
  return {
    name: input.name,
    mediaType,
    text: input.text,
    sizeBytes: bytes(input.text),
    sha256: createHash('sha256').update(input.text, 'utf8').digest('hex'),
  };
}

// ---------------------------------------------------------------------------------------------
// Views and evidence passages.

const lineCount = (text: string): number => text.replace(/\n$/, '').split('\n').length;

type RefColumns = Pick<AttachmentRow, 'id' | 'name' | 'media_type' | 'size_bytes'>;

const attachmentRef = (row: RefColumns): AttachmentRef => ({
  id: row.id,
  name: row.name,
  mediaType: row.media_type,
  sizeBytes: row.size_bytes,
});

function attachmentView(row: AttachmentRow): AttachmentView {
  return {
    ...attachmentRef(row),
    sha256: row.sha256,
    createdAt: row.created_at.toISOString(),
    preview: row.text.slice(0, ATTACHMENT_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, ''),
    lines: lineCount(row.text),
    removedAt: row.removed_at?.toISOString() ?? null,
  };
}

type Passage = { readonly from: number; readonly to: number; readonly text: string };

/** Pieces of one line that is longer than a passage by itself, cut between characters. */
function pieces(line: string): string[] {
  const out: string[] = [];
  let held = '';
  for (const char of line) {
    if (bytes(held) + bytes(char) > PASSAGE_MAX_BYTES) {
      out.push(held);
      held = '';
    }
    held += char;
  }
  return held.length === 0 ? out : [...out, held];
}

/** Lines grouped into passages of at most `PASSAGE_MAX_BYTES`, each naming the lines it spans. */
function passages(text: string): readonly Passage[] {
  const out: Passage[] = [];
  let held: string[] = [];
  let size = 0;
  let from = 1;
  const flush = (to: number): void => {
    const body = held.join('\n').trimEnd();
    if (body.length > 0) out.push({ from, to, text: body });
    held = [];
    size = 0;
    from = to + 1;
  };
  text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .forEach((line, index) => {
      const number = index + 1;
      const lineBytes = bytes(line) + 1;
      if (held.length > 0 && size + lineBytes > PASSAGE_MAX_BYTES) flush(number - 1);
      if (lineBytes > PASSAGE_MAX_BYTES) {
        for (const piece of pieces(line)) out.push({ from: number, to: number, text: piece });
        from = number + 1;
        return;
      }
      held.push(line);
      size += lineBytes;
    });
  flush(from + held.length - 1);
  return out;
}

/** The evidence rows a task records for member files: one per passage, citable like any source. */
export function attachmentItems(rows: readonly AttachmentRow[]): SourceItem[] {
  return rows.flatMap((row) =>
    passages(row.text).map((passage) => ({
      sourceKind: 'member_file' as const,
      sourceId: `attachment:${row.id}`,
      title: row.name,
      location: `lines ${passage.from}-${passage.to}`,
      excerpt: passage.text,
      url: null,
      sourceRevision: row.sha256.slice(0, 12),
      modifiedAt: row.created_at.toISOString(),
      provenance: `MEMBER UPLOAD sha256:${row.sha256.slice(0, 12)}`,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Storage. Every read is scoped by the owner; another member's id is not found.

export async function uploadAttachment(
  deps: Deps,
  member: Member,
  conversationId: string,
  input: AttachmentUpload,
): Promise<AttachmentView> {
  const file = validateAttachment(input);
  const owned =
    await deps.sql`select 1 from tw_conversations where id = ${conversationId} and owner_sub = ${member.sub}`;
  if (owned.length === 0) throw new Conflict('not_found', 404);
  const rows = await deps.sql<AttachmentRow[]>`
    insert into tw_attachments (id, owner_sub, conversation_id, name, media_type, size_bytes, sha256, text, created_at)
    values (${deps.newId()}, ${member.sub}, ${conversationId}, ${file.name}, ${file.mediaType}, ${file.sizeBytes},
      ${file.sha256}, ${file.text}, ${deps.now()})
    returning *
  `;
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    action: 'attachment.upload',
    outcome: 'stored',
    detail: { mediaType: file.mediaType, sizeBytes: file.sizeBytes },
  });
  return attachmentView(rows[0]);
}

export async function getAttachment(
  deps: Deps,
  member: Member,
  id: string,
): Promise<{ attachment: AttachmentView; text: string } | undefined> {
  const row = (
    await deps.sql<
      AttachmentRow[]
    >`select * from tw_attachments where id = ${id} and owner_sub = ${member.sub}`
  ).at(0);
  return row === undefined ? undefined : { attachment: attachmentView(row), text: row.text };
}

/** Soft removal; a file a task scope or a sent message references stays as provenance. */
export async function removeAttachment(deps: Deps, member: Member, id: string): Promise<void> {
  await deps.sql.begin(async (tx) => {
    const row = (
      await tx<
        { removed_at: Date | null }[]
      >`select removed_at from tw_attachments where id = ${id} and owner_sub = ${member.sub} for update`
    ).at(0);
    if (row === undefined) throw new Conflict('not_found', 404);
    if (row.removed_at !== null) return;
    const used = await tx`
      select 1 from tw_messages where owner_sub = ${member.sub} and attachment_ids ? ${id}
      union all
      select 1 from wb_tasks where owner_sub = ${member.sub} and scope->'attachmentIds' ? ${id}
      limit 1
    `;
    if (used.length > 0)
      throw new Conflict(
        'attachment_in_use',
        409,
        'A task or a sent message references this file; it stays as provenance.',
      );
    await tx`update tw_attachments set removed_at = ${deps.now()} where id = ${id}`;
    await audit(deps, tx, {
      ownerSub: member.sub,
      action: 'attachment.remove',
      outcome: 'removed',
    });
  });
}

export async function attachmentsByIds(
  db: Db,
  ownerSub: string,
  ids: readonly string[],
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  return db<AttachmentRow[]>`
    select * from tw_attachments where owner_sub = ${ownerSub} and id = any(${ids as string[]}::uuid[])
    order by created_at, id
  `;
}

/**
 * The files a message or task may carry: each must be the member's, uploaded in this
 * conversation and not removed. Returned in the order given, without duplicates.
 */
export async function resolveAttachments(
  db: Db,
  member: Member,
  conversationId: string | null,
  ids: readonly string[],
): Promise<AttachmentRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (conversationId === null)
    throw new Conflict(
      'attachments_need_conversation',
      400,
      'Files can only go with a message or a task in the conversation they were uploaded to.',
    );
  const rows = new Map(
    (await attachmentsByIds(db, member.sub, unique)).map((row) => [row.id, row]),
  );
  return unique.map((id) => {
    const row = rows.get(id);
    if (row === undefined) throw new Conflict('attachment_not_found', 404);
    if (row.conversation_id !== conversationId)
      throw new Conflict(
        'attachment_not_in_conversation',
        400,
        `"${row.name}" was uploaded in another conversation.`,
      );
    if (row.removed_at !== null)
      throw new Conflict('attachment_removed', 409, `"${row.name}" was removed; attach it again.`);
    return row;
  });
}

/** Chip data for the files each message carries, keyed by message id. */
export async function attachmentRefsFor(
  db: Db,
  messages: readonly { readonly id: string; readonly attachment_ids: readonly string[] }[],
): Promise<Map<string, AttachmentRef[]>> {
  const ids = [...new Set(messages.flatMap((message) => message.attachment_ids))];
  const refs =
    ids.length === 0
      ? []
      : await db<RefColumns[]>`
          select id, name, media_type, size_bytes from tw_attachments where id = any(${ids}::uuid[])
        `;
  const byId = new Map(refs.map((row) => [row.id, attachmentRef(row)]));
  return new Map(
    messages.map((message) => [
      message.id,
      message.attachment_ids.flatMap((id) => {
        const ref = byId.get(id);
        return ref === undefined ? [] : [ref];
      }),
    ]),
  );
}
