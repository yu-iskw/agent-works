// Where a Send goes when the conversation has tasks: the default or the member's choice, shown as
// an editable chip. With several candidates and no choice, the row asks instead of guessing.

import { useState } from 'preact/hooks';

import { targetKey } from '../../../../shared/composer.js';
import { defaultTarget, targetLabel } from '../../store/composer-routing.js';
import { useWorkspace } from '../context.js';

import type { FollowUpTarget } from '../../../../shared/composer.js';
import type { JSX } from 'preact';

export function TargetChip(props: {
  readonly candidates: readonly FollowUpTarget[];
  readonly chosen: FollowUpTarget | null;
  readonly teammateName: string;
  /** Forced open by a Send that could not decide. */
  readonly clarify: boolean;
  readonly onPicked: () => void;
}): JSX.Element | null {
  const { effects } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (props.candidates.length <= 1) return null;
  const effective = props.chosen ?? defaultTarget(props.candidates);
  // With no default there is no chip to open the list from, so the choices show at once.
  const showList = open || props.clarify || effective === null;
  const pick = (target: FollowUpTarget) => {
    // An explicit pick stays explicit, even when targets that arrive later would change the default.
    effects.setTarget(target);
    setOpen(false);
    props.onPicked();
  };
  return (
    <div class="tg" role="group" aria-label="Send target">
      {effective === null || props.clarify ? (
        <span class="tg-ask" id="tg-ask">
          Where should this go?
        </span>
      ) : (
        <button
          type="button"
          class="tg-chip"
          aria-expanded={showList}
          aria-controls="tg-list"
          onClick={() => setOpen((was) => !was)}
        >
          <span class="tg-label">{targetLabel(effective, props.teammateName)}</span>
          <span class="tg-change" aria-hidden="true">
            Change
          </span>
        </button>
      )}
      {showList ? (
        <div
          id="tg-list"
          class="tg-list"
          role="radiogroup"
          aria-labelledby={props.clarify ? 'tg-ask' : undefined}
          aria-label={props.clarify ? undefined : 'Send target'}
        >
          {props.candidates.map((candidate) => {
            const key = targetKey(candidate);
            const checked = effective !== null && targetKey(effective) === key;
            return (
              <label key={key} class="tg-opt">
                <input
                  type="radio"
                  name="tg"
                  value={key}
                  checked={checked && !props.clarify}
                  onChange={() => pick(candidate)}
                />
                <span>{targetLabel(candidate, props.teammateName)}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
