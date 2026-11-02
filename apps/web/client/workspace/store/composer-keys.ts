import type { SendKey } from '../../../shared/contract.js';

export type KeyFacts = {
  readonly enter: boolean;
  readonly shift: boolean;
  readonly mod: boolean;
  /** From compositionstart/compositionend or keyCode 229; an IME confirm must never send. */
  readonly composing: boolean;
};

export type EnterAction = 'send' | 'newline' | 'none';

export function enterAction(key: KeyFacts, sendKey: SendKey): EnterAction {
  if (!key.enter) return 'none';
  if (key.composing) return 'none';
  if (key.mod) return 'send';
  if (key.shift) return 'newline';
  return sendKey === 'enter' ? 'send' : 'newline';
}
