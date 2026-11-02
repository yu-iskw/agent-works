// Member-level preferences. Each choice applies at once and persists through the BFF; the server
// renders the next document with the chosen theme already set, so a reload never flashes.

import { SEND_KEYS, STARTUPS, THEMES } from '../../../../shared/contract.js';
import { useWorkspace } from '../context.js';

import type { SendKey, Startup, Theme } from '../../../../shared/contract.js';
import type { JSX } from 'preact';

type Option = { readonly label: string; readonly hint?: string };

/** One entry per contract value, so a new theme or startup cannot ship without copy. */
const THEME_OPTIONS: Readonly<Record<Theme, Option>> = {
  system: { label: 'System' },
  light: { label: 'Light' },
  dark: { label: 'Dark' },
};

const STARTUP_OPTIONS: Readonly<Record<Startup, Option>> = {
  last: {
    label: 'Last conversation',
    hint: 'Opens the conversation you were in when you left.',
  },
  inbox: {
    label: 'Attention inbox',
    hint: 'Opens the decisions and results waiting on you, over your last conversation.',
  },
  recap: {
    label: 'Coordinator recap',
    hint: 'Opens a summary of open decisions, running work and recent results. No model call.',
  },
};

const SEND_OPTIONS: Readonly<Record<SendKey, Option>> = {
  enter: { label: 'Enter', hint: 'Shift+Enter adds a line.' },
  'mod-enter': { label: 'Ctrl/Cmd+Enter', hint: 'Enter adds a line.' },
};

function Choice<T extends string>(props: {
  readonly name: string;
  readonly legend: string;
  readonly values: readonly T[];
  readonly options: Readonly<Record<T, Option>>;
  readonly value: T;
  readonly segmented?: boolean;
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <fieldset class={props.segmented ? 'seg-radio pref' : 'pref pref-list'}>
      <legend>{props.legend}</legend>
      {props.values.map((value) => {
        // `value` ranges over the closed contract enum this choice was given.
        // eslint-disable-next-line security/detect-object-injection
        const option = props.options[value];
        return (
          <label key={value} class={props.segmented ? 'seg-opt' : 'pref-opt'}>
            <input
              type="radio"
              name={props.name}
              value={value}
              checked={props.value === value}
              onChange={() => props.onChange(value)}
            />
            <span>
              {option.label}
              {option.hint === undefined || props.segmented ? null : (
                <span class="field-hint">{option.hint}</span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function PreferencesPanel(): JSX.Element {
  const { store, effects } = useWorkspace();
  const prefs = store.prefs.value;
  const me = store.me.value;
  return (
    <div class="prefs">
      <p class="muted">
        These apply to you, {me.member.name}, in every segment. They never change a teammate or what
        it may do.
      </p>
      <Choice
        name="theme"
        legend="Appearance"
        values={THEMES}
        options={THEME_OPTIONS}
        value={prefs.theme}
        segmented
        onChange={(theme) => void effects.setPrefs({ theme })}
      />
      <Choice
        name="startup"
        legend="Startup view"
        values={STARTUPS}
        options={STARTUP_OPTIONS}
        value={prefs.startup}
        onChange={(startup) => void effects.setPrefs({ startup })}
      />
      <Choice
        name="sendKey"
        legend="Send with"
        values={SEND_KEYS}
        options={SEND_OPTIONS}
        value={prefs.sendKey}
        onChange={(sendKey) => void effects.setPrefs({ sendKey })}
      />
    </div>
  );
}
