// Member file uploads behind the file chips: pre-check, read, upload with cancel, retry, and the
// removal that keeps the segment in step when a chip goes away. File text lives only here.

import { FILE_MAX_BYTES, checkFile, utf8Length } from '../../../shared/composer.js';
import { api as paths } from '../../../shared/contract.js';

import { errorText } from './composer-errors.js';
import { draftOf } from './selectors.js';

import type { EffectsDeps } from './effects.js';
import type { ContextChip, FileChip } from '../../../shared/composer.js';
import type { AttachmentView } from '@agent-works/domain/teamwork';

export type FileEffects = {
  readonly attachFiles: (files: readonly File[]) => void;
  readonly retryFile: (localId: string) => void;
  /** Aborts an upload in flight or removes a stored file; the chip itself is the caller's. */
  readonly forget: (chip: FileChip) => void;
  readonly clear: () => void;
};

type FileDeps = {
  readonly deps: EffectsDeps;
  readonly readText: (file: File) => Promise<string>;
  readonly addChip: (chip: ContextChip) => void;
  readonly fail: (reason: string) => void;
};

type AttachmentReply = { readonly segment: string; readonly attachment: AttachmentView };

const newChip = (file: File, mediaType: FileChip['mediaType'], localId: string): FileChip => ({
  kind: 'file',
  localId,
  name: file.name,
  mediaType,
  sizeBytes: file.size,
  status: 'uploading',
  attachmentId: null,
  error: null,
  preview: null,
  lines: null,
  sha256: null,
});

export function createFileEffects(input: FileDeps): FileEffects {
  const { deps, readText, addChip, fail } = input;
  const { store, api } = deps;
  const { dispatch, peek } = store;
  const segment = peek().scope.segment;
  const pending = new Map<string, { text: string; controller: AbortController | null }>();

  const conversationId = (): string | null => peek().conversation?.id ?? null;

  const fileChips = (id: string): readonly FileChip[] =>
    draftOf(peek(), id).chips.filter((c): c is FileChip => c.kind === 'file');

  const patch = (id: string, localId: string, p: Partial<Omit<FileChip, 'kind' | 'localId'>>) =>
    dispatch({ type: 'draft/file', conversationId: id, localId, patch: p });

  const remove = (attachmentId: string) =>
    void api.post(paths.attachmentRemove(segment, attachmentId), {}).catch(() => undefined);

  async function upload(id: string, chip: FileChip, text: string): Promise<void> {
    const controller = new AbortController();
    pending.set(chip.localId, { text, controller });
    patch(id, chip.localId, { status: 'uploading', error: null });
    try {
      const reply = await api.post<AttachmentReply>(
        paths.attachments(segment, id),
        { name: chip.name, mediaType: chip.mediaType, text },
        { signal: controller.signal },
      );
      const a = reply.attachment;
      const wanted = fileChips(id).some((c) => c.localId === chip.localId);
      if (!wanted || controller.signal.aborted) {
        remove(a.id);
        return;
      }
      patch(id, chip.localId, {
        status: 'ready',
        attachmentId: a.id,
        sizeBytes: a.sizeBytes,
        preview: a.preview,
        lines: a.lines,
        sha256: a.sha256,
        error: null,
      });
    } catch (error) {
      if (!controller.signal.aborted)
        patch(id, chip.localId, {
          status: 'failed',
          error: errorText(error, 'Retry or remove it.'),
        });
    } finally {
      if (pending.get(chip.localId)?.controller === controller)
        pending.set(chip.localId, { text, controller: null });
    }
  }

  function attachOne(id: string, file: File): void {
    const check = checkFile(file, fileChips(id).length);
    if (!check.ok) {
      fail(check.message);
      return;
    }
    const chip = newChip(file, check.mediaType, deps.mintId());
    addChip(chip);
    readText(file).then(
      (text) =>
        utf8Length(text) > FILE_MAX_BYTES
          ? patch(id, chip.localId, {
              status: 'failed',
              error: 'The file is over 200 KB once decoded.',
            })
          : upload(id, chip, text),
      () => patch(id, chip.localId, { status: 'failed', error: 'The file could not be read.' }),
    );
  }

  return {
    attachFiles: (files) => {
      const id = conversationId();
      if (id !== null) for (const file of files) attachOne(id, file);
    },
    retryFile: (localId) => {
      const id = conversationId();
      if (id === null) return;
      const chip = fileChips(id).find((c) => c.localId === localId);
      if (chip === undefined) return;
      const entry = pending.get(localId);
      if (entry === undefined) {
        patch(id, localId, {
          status: 'failed',
          error: 'The file is gone after a reload. Remove it and attach it again.',
        });
        return;
      }
      void upload(id, chip, entry.text);
    },
    forget: (chip) => {
      pending.get(chip.localId)?.controller?.abort();
      pending.delete(chip.localId);
      if (chip.attachmentId !== null) remove(chip.attachmentId);
    },
    clear: () => pending.clear(),
  };
}
