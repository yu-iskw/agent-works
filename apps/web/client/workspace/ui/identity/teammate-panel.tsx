// Teammate details and the identity editor. Identity (avatar, name, role label, accent) is
// private to this member's teammate; skills attach to this instance only; capabilities are the
// effective intersection and read-only here. Saves carry `expectedVersion`, and a 409 reloads.

import { useEffect, useState } from 'preact/hooks';

import { ACCENT_IDS, AVATAR_IDS, pages } from '../../../../shared/contract.js';
import { ApiFailure } from '../../api.js';
import { activeTeammate } from '../../store/selectors.js';
import { AvatarMark } from '../avatars.jsx';
import { useWorkspace } from '../context.js';

import { resolveAppearance } from './appearance.js';

import type {
  AccentId,
  AvatarId,
  SkillOption,
  TeammateDetail,
} from '../../../../shared/contract.js';
import type { JSX } from 'preact';

const AVATAR_NAME: Readonly<Record<AvatarId, string>> = {
  leaf: 'Leaf',
  sun: 'Sun',
  moon: 'Moon',
  wave: 'Wave',
  spark: 'Spark',
  stone: 'Stone',
  bloom: 'Bloom',
  orbit: 'Orbit',
};

const ACCENT_NAME: Readonly<Record<AccentId, string>> = {
  mint: 'Mint',
  amber: 'Amber',
  lavender: 'Lavender',
  blue: 'Blue',
  coral: 'Coral',
  slate: 'Slate',
};

type Form = {
  readonly name: string;
  readonly role: string;
  readonly avatar: AvatarId;
  readonly accent: AccentId;
};

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'missing' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'ready'; readonly detail: TeammateDetail };

const formOf = (detail: TeammateDetail): Form => ({
  name: detail.name,
  role: detail.role,
  ...resolveAppearance(detail.appearance, detail.id),
});

function failureText(error: unknown): string {
  if (error instanceof ApiFailure && error.status === 409)
    return 'This teammate changed elsewhere. The latest version is shown; apply your edits again.';
  if (error instanceof ApiFailure && error.status === 404)
    return 'This teammate is no longer available.';
  return 'The change could not be saved. Try again.';
}

function AvatarPicker(props: {
  readonly value: AvatarId;
  readonly accent: AccentId;
  readonly onChange: (avatar: AvatarId) => void;
}): JSX.Element {
  return (
    <fieldset class="pick">
      <legend>Avatar</legend>
      <div class="pick-grid" role="radiogroup" aria-label="Avatar">
        {AVATAR_IDS.map((avatar) => (
          <label key={avatar} class="pick-opt">
            <input
              type="radio"
              name="avatar"
              value={avatar}
              checked={props.value === avatar}
              onChange={() => props.onChange(avatar)}
            />
            {/* `avatar` is the closed AvatarId enum. */}
            <span class="avatar pick-tile" data-accent={props.accent} aria-hidden="true">
              <AvatarMark avatar={avatar} size={36} />
            </span>
            <span class="visually-hidden">
              {
                // eslint-disable-next-line security/detect-object-injection
                AVATAR_NAME[avatar]
              }
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AccentPicker(props: {
  readonly value: AccentId;
  readonly onChange: (accent: AccentId) => void;
}): JSX.Element {
  return (
    <fieldset class="pick">
      <legend>Accent color</legend>
      <div class="pick-row" role="radiogroup" aria-label="Accent color">
        {ACCENT_IDS.map((accent) => (
          <label key={accent} class="pick-opt pick-swatch-opt">
            <input
              type="radio"
              name="accent"
              value={accent}
              checked={props.value === accent}
              onChange={() => props.onChange(accent)}
            />
            <span class="swatch" data-accent={accent} aria-hidden="true" />
            {/* `accent` is the closed AccentId enum. */}
            <span class="pick-name">
              {
                // eslint-disable-next-line security/detect-object-injection
                ACCENT_NAME[accent]
              }
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Skills(props: {
  readonly skills: readonly SkillOption[];
  readonly busy: boolean;
  readonly onToggle: (skill: SkillOption) => void;
}): JSX.Element {
  const attached = props.skills.filter((s) => s.attached);
  const available = props.skills.filter((s) => !s.attached);
  return (
    <section class="pn-section" aria-labelledby="skills-title">
      <h3 id="skills-title">Skills</h3>
      <p class="muted">Private to your teammate. Attaching a skill does not change the template.</p>
      {attached.length === 0 ? (
        <p class="side-empty">No skills attached.</p>
      ) : (
        <ul class="chips" aria-label="Attached skills">
          {attached.map((skill) => (
            <li key={skill.id} class="chip">
              <span>{skill.name}</span>
              <button
                type="button"
                class="chip-x"
                aria-label={`Detach ${skill.name}`}
                disabled={props.busy}
                onClick={() => props.onToggle(skill)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length === 0 ? null : (
        <details class="attach">
          <summary>Attach a skill</summary>
          <ul class="rows" aria-label="Available skills">
            {available.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  class="row"
                  disabled={props.busy}
                  onClick={() => props.onToggle(skill)}
                >
                  <span class="row-title">{skill.name}</span>
                  <span class="row-sub">{skill.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Editor(props: { readonly detail: TeammateDetail; readonly onReload: () => void }) {
  const { effects, store } = useWorkspace();
  const { detail } = props;
  const [form, setForm] = useState<Form>(() => formOf(detail));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setForm(formOf(detail)), [detail]);
  const segment = store.scope.value.segment;
  const dirty =
    form.name !== detail.name ||
    form.role !== detail.role ||
    form.avatar !== detail.appearance.avatar ||
    form.accent !== detail.appearance.accent;
  const valid = form.name.trim() !== '' && form.role.trim() !== '';

  async function run(work: () => Promise<TeammateDetail>, done: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'ok', text: done });
    } catch (error) {
      setMessage({ tone: 'error', text: failureText(error) });
      if (error instanceof ApiFailure && error.status === 409) props.onReload();
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      () =>
        effects.identity.save(detail.id, {
          expectedVersion: detail.version,
          name: form.name.trim(),
          role: form.role.trim(),
          avatar: form.avatar,
          accent: form.accent,
        }),
      'Saved.',
    ).then(props.onReload);

  const toggle = (skill: SkillOption) =>
    run(
      () =>
        effects.identity.setSkill(detail.id, {
          skillId: skill.id,
          version: skill.version,
          attach: !skill.attached,
        }),
      skill.attached ? `Detached ${skill.name}.` : `Attached ${skill.name}.`,
    ).then(props.onReload);

  const effective = detail.capabilities.filter((c) => c.effective);
  const requested = detail.capabilities.filter((c) => c.requested && !c.effective);
  return (
    <div class="identity">
      <div class="identity-preview">
        <span class="avatar" data-accent={form.accent} role="img" aria-label={form.name}>
          <AvatarMark avatar={form.avatar} size={64} />
        </span>
        <div>
          <p class="identity-name">{form.name.trim() === '' ? detail.name : form.name}</p>
          <p class="muted">From template {detail.template.name} · private to you</p>
        </div>
      </div>
      <form
        class="identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && valid && !busy) void save();
        }}
      >
        <AvatarPicker
          value={form.avatar}
          accent={form.accent}
          onChange={(avatar) => setForm({ ...form, avatar })}
        />
        <label class="field">
          <span>Display name</span>
          <input
            type="text"
            value={form.name}
            maxLength={80}
            required
            onInput={(event) => setForm({ ...form, name: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>Role label</span>
          <input
            type="text"
            value={form.role}
            maxLength={160}
            required
            onInput={(event) => setForm({ ...form, role: event.currentTarget.value })}
          />
          <span class="field-hint">
            Display only. It does not change what this teammate may do.
          </span>
        </label>
        <AccentPicker value={form.accent} onChange={(accent) => setForm({ ...form, accent })} />
        <div class="identity-actions">
          <button
            type="button"
            class="btn btn-quiet"
            disabled={!dirty || busy}
            onClick={() => setForm(formOf(detail))}
          >
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={!dirty || !valid || busy}>
            Save changes
          </button>
        </div>
        {message === null ? null : (
          <p class={`form-msg form-msg-${message.tone}`} role="status">
            {message.text}
          </p>
        )}
      </form>
      <Skills skills={detail.skills} busy={busy} onToggle={(skill) => void toggle(skill)} />
      <section class="pn-section" aria-labelledby="caps-title">
        <h3 id="caps-title">Effective capabilities</h3>
        <p class="muted">
          Segment policy, your entitlement, the template's requests and your connections, combined.
          Editing identity never changes these.
        </p>
        {effective.length === 0 ? (
          <p class="side-empty">None are effective right now.</p>
        ) : (
          <ul class="caps" aria-label="Effective capabilities">
            {effective.map((c) => (
              <li key={c.capability}>{c.capability}</li>
            ))}
          </ul>
        )}
        {requested.length === 0 ? null : (
          <p class="muted">
            Requested but not effective: {requested.map((c) => c.capability).join(', ')}.
          </p>
        )}
      </section>
      <section class="pn-section">
        <h3>Export</h3>
        <p class="muted">
          <a href={pages.teammateExport(segment, detail.id)}>Export this teammate</a> as a portable
          definition. Your identity edits and private skills stay with your copy.
        </p>
      </section>
    </div>
  );
}

export function TeammatePanel(): JSX.Element {
  const { effects, store } = useWorkspace();
  const row = activeTeammate(store.state.value);
  const id = row?.id ?? null;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (id === null) {
      setLoad({ state: 'missing' });
      return;
    }
    let live = true;
    // A reload keeps the editor (and its status line) on screen until the new detail arrives.
    setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    effects.identity
      .detail(id)
      .then((detail) => live && setLoad({ state: 'ready', detail }))
      .catch(
        (error: unknown) =>
          live &&
          setLoad(
            error instanceof ApiFailure && error.status === 404
              ? { state: 'missing' }
              : { state: 'error', message: failureText(error) },
          ),
      );
    return () => {
      live = false;
    };
  }, [id, tick, effects]);
  if (load.state === 'loading')
    return (
      <p class="side-empty" aria-live="polite">
        Loading teammate…
      </p>
    );
  if (load.state === 'missing')
    return (
      <p class="side-empty">
        This teammate is no longer available. It may have been archived or removed.
      </p>
    );
  if (load.state === 'error')
    return (
      <p class="side-empty" role="alert">
        {load.message}{' '}
        <button type="button" class="link" onClick={() => setTick((n) => n + 1)}>
          Try again
        </button>
      </p>
    );
  return <Editor detail={load.detail} onReload={() => setTick((n) => n + 1)} />;
}
