// The line under the composer: the error (role=alert) or the hint with the send-key toggle folded
// into it, plus the upload state and the read-only notice.

import { useWorkspace } from '../context.js';

import type { SendKey } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

function SendKeyToggle(props: { readonly sendKey: SendKey }): JSX.Element {
  const { effects } = useWorkspace();
  const { sendKey } = props;
  const other = sendKey === 'enter' ? 'Ctrl+Enter' : 'Enter';
  const current = sendKey === 'enter' ? 'Enter' : 'Ctrl+Enter';
  return (
    <button
      type="button"
      class="link cp-sendkey"
      aria-label={`Use ${other} to send instead of ${current}`}
      aria-pressed={sendKey === 'mod-enter'}
      onClick={() =>
        void effects.setPrefs({ sendKey: sendKey === 'enter' ? 'mod-enter' : 'enter' })
      }
    >
      Use {other}
    </button>
  );
}

export function ComposerFoot(props: {
  readonly error: string | null;
  readonly hasWork: boolean;
  readonly uploading: boolean;
  readonly readOnly: boolean;
  readonly sendKey: SendKey;
}): JSX.Element {
  const { sendKey } = props;
  const keys =
    sendKey === 'enter'
      ? 'Enter to send · Shift+Enter for a new line'
      : 'Ctrl/Cmd+Enter to send · Enter for a new line';
  return (
    <div class="cp-foot">
      {props.error !== null ? (
        <span class="cp-error" role="alert">
          {props.error}
        </span>
      ) : (
        <span class="cp-hint">
          {props.hasWork
            ? 'Sources, files or teammates make this a task. Send opens a task draft to review before it starts.'
            : keys}
          {' · '}
          <SendKeyToggle sendKey={sendKey} />
        </span>
      )}
      <span class="cp-foot-right">
        {props.uploading ? <span class="cp-hint">Uploading…</span> : null}
        {props.readOnly ? <span class="cp-hint">Read-only in this segment</span> : null}
      </span>
    </div>
  );
}
