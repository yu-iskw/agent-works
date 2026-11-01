// Context chips above the message: files (with upload state, retry and preview), teammates,
// skills and sources. Every chip has a labelled remove button; a file chip opens its preview.

import { useEffect, useRef, useState } from 'preact/hooks';

import { chipKey } from '../../../../shared/composer.js';
import { useWorkspace } from '../context.js';

import type { ContextChip, FileChip } from '../../../../shared/composer.js';
import type { JSX } from 'preact';

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

const KIND_LABEL = {
  teammate: 'Teammate',
  skill: 'Skill',
  source: 'Source',
  file: 'File',
} as const;

function FilePreview(props: {
  readonly chip: FileChip;
  readonly onClose: () => void;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector('button')?.focus(), []);
  const { chip } = props;
  return (
    <div
      ref={box}
      class="cx-preview"
      role="dialog"
      aria-label={`Preview of ${chip.name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div class="cx-preview-head">
        <strong>{chip.name}</strong>
        <button
          type="button"
          class="btn btn-icon btn-sm"
          aria-label="Close preview"
          onClick={props.onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p class="cx-provenance">
        {kb(chip.sizeBytes)} · {chip.lines ?? '?'} lines · uploaded by you
        {chip.sha256 === null ? '' : ` · sha256 ${chip.sha256.slice(0, 12)}`}
      </p>
      <pre class="cx-preview-text">{chip.preview ?? ''}</pre>
    </div>
  );
}

function FileFace(props: {
  readonly chip: FileChip;
  readonly open: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const { chip } = props;
  return (
    <button
      type="button"
      class="cx-main"
      aria-expanded={props.open}
      aria-busy={chip.status === 'uploading'}
      onClick={props.onToggle}
      title={chip.error ?? undefined}
    >
      <span class="cx-kind">{KIND_LABEL.file}</span>
      <span class="cx-name">{chip.name}</span>
      {chip.status === 'uploading' ? <span class="cx-state">Uploading…</span> : null}
      {chip.status === 'failed' ? <span class="cx-state cx-state-error">Failed</span> : null}
    </button>
  );
}

function ChipItem(props: {
  readonly chip: ContextChip;
  readonly previewOpen: boolean;
  readonly onPreview: (localId: string | null) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const { effects } = useWorkspace();
  const { chip } = props;
  const file = chip.kind === 'file' ? chip : null;
  const failed = file !== null && file.status === 'failed';
  const key = chipKey(chip);
  return (
    <span class={`cx cx-${chip.kind}${file === null ? '' : ` cx-${file.status}`}`} data-chip={key}>
      {file !== null ? (
        <FileFace
          chip={file}
          open={props.previewOpen}
          onToggle={() => props.onPreview(props.previewOpen ? null : file.localId)}
        />
      ) : (
        <span class="cx-main">
          <span class="cx-kind">{KIND_LABEL[chip.kind]}</span>
          <span class="cx-name">{chip.name}</span>
        </span>
      )}
      {failed ? (
        <button
          type="button"
          class="btn btn-quiet btn-sm cx-retry"
          onClick={() => effects.retryFile(file.localId)}
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        class="cx-x"
        aria-label={`Remove ${chip.name}`}
        onClick={props.onRemove}
        onKeyDown={(event) => {
          if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            props.onRemove();
          }
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
      {failed && file.error !== null ? (
        <span class="cx-error" role="alert">
          {file.error}
        </span>
      ) : null}
      {file !== null && props.previewOpen ? (
        <FilePreview chip={file} onClose={() => props.onPreview(null)} />
      ) : null}
    </span>
  );
}

export function ChipRow(props: {
  readonly chips: readonly ContextChip[];
  readonly onFocusTextarea: () => void;
}): JSX.Element | null {
  const { effects } = useWorkspace();
  const [preview, setPreview] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  if (props.chips.length === 0) return null;
  const removeAt = (index: number) => {
    const removed = props.chips.at(index);
    if (removed === undefined) return;
    effects.removeChip(chipKey(removed));
    const buttons = [...(row.current?.querySelectorAll<HTMLButtonElement>('.cx-x') ?? [])];
    const next = buttons.at(index - 1) ?? buttons.at(index + 1);
    if (index > 0 && next !== undefined) next.focus();
    else props.onFocusTextarea();
  };
  const closePreview = (localId: string | null) => {
    if (localId === null && preview !== null) {
      const key = `file:${preview}`;
      row.current?.querySelector<HTMLButtonElement>(`[data-chip="${key}"] .cx-main`)?.focus();
    }
    setPreview(localId);
  };
  return (
    <div class="cx-row" ref={row} role="group" aria-label="Context">
      {props.chips.map((chip, index) => (
        <ChipItem
          key={chipKey(chip)}
          chip={chip}
          previewOpen={chip.kind === 'file' && preview === chip.localId}
          onPreview={closePreview}
          onRemove={() => removeAt(index)}
        />
      ))}
    </div>
  );
}
