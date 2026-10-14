import { randomUUID } from 'node:crypto';

import { suspensionScopes } from '@agent-works/domain';

import { h, renderDocument } from '../html.js';

import type { Html } from '../html.js';
import type { Suspension, CapabilityVersion } from '@agent-works/domain';

export type AdminPageView = {
  readonly suspensions: readonly Suspension[];
  readonly versions: readonly CapabilityVersion[];
  readonly events: readonly {
    eventType: string;
    actorSub: string;
    reason: string;
    occurredAt: string;
    digest: string;
  }[];
  readonly csrfToken: string;
  readonly message?: string;
};
const confirmationAction = '/admin/confirm';
const hidden = (name: string, value: string | number) =>
  h('input', { type: 'hidden', name, value });
const field = (name: string, text: string, value = '') =>
  h(
    'label',
    null,
    text,
    h('input', { name, value, required: name !== 'version' && name !== 'expiresAt' }),
  );
export function adminPage(view: AdminPageView): string {
  return renderDocument(
    h(
      'main',
      null,
      h(
        'nav',
        null,
        h('a', { href: '/' }, 'Ask'),
        ' / ',
        h('a', { href: '/admin' }, 'Administration'),
      ),
      h('h1', null, 'Suspension control plane'),
      h(
        'p',
        null,
        'Operator drill has not run. Local tests do not satisfy RFC-001 §21 or the P3-ADM gate.',
      ),
      view.message === undefined ? null : h('p', { role: 'status' }, view.message),
      h('h2', null, 'Suspensions'),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...[
              'Scope',
              'Target',
              'Version',
              'State',
              'Reason',
              'Actor',
              'Expiry',
              'Revision',
              'Action',
            ].map((label) => h('th', { scope: 'col' }, label)),
          ),
        ),
        h(
          'tbody',
          null,
          view.suspensions.map((value) => suspensionRow(value, view.csrfToken)),
        ),
      ),
      h('h2', null, 'Suspend a target'),
      suspendForm(view.csrfToken),
      h('h2', null, 'Capability versions'),
      h(
        'p',
        null,
        'Draft → published → deprecated → revoked. Revocation is permanent. Pinned tasks stop; no automatic migration.',
      ),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...['Kind', 'ID', 'Version', 'State', 'Revision', 'Reason'].map((label) =>
              h('th', { scope: 'col' }, label),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          view.versions.map((value) =>
            h(
              'tr',
              null,
              ...[
                value.pin.kind,
                value.pin.id,
                value.pin.version,
                value.state,
                value.revision,
                value.reason,
              ].map((text) => h('td', null, text)),
            ),
          ),
        ),
      ),
      versionForm(view.csrfToken),
      h('h2', null, 'Audit trail'),
      h(
        'ol',
        null,
        view.events.map((event) =>
          h(
            'li',
            null,
            `${event.occurredAt} — ${event.eventType} by ${event.actorSub}: ${event.reason} `,
            h('code', null, event.digest),
          ),
        ),
      ),
    ),
  );
}
function suspensionRow(value: Suspension, token: string): Html {
  const state = value.suspended
    ? value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.now()
      ? 'expired'
      : 'suspended'
    : 'resumed';
  return h(
    'tr',
    null,
    ...[
      value.target.scope,
      value.target.id,
      value.target.version ?? 'all',
      state,
      value.reason,
      value.actorSub,
      value.expiresAt ?? 'none',
      value.revision,
    ].map((text) => h('td', null, text)),
    h(
      'td',
      null,
      value.suspended
        ? h(
            'form',
            { method: 'post', action: confirmationAction },
            hidden('csrfToken', token),
            hidden('commandId', randomUUID()),
            hidden('kind', 'suspension'),
            hidden('action', 'resume'),
            hidden('scope', value.target.scope),
            hidden('id', value.target.id),
            hidden('version', value.target.version ?? ''),
            hidden('expectedRevision', value.revision),
            field('reason', 'Resume reason'),
            h('button', { type: 'submit' }, 'Review resume'),
          )
        : null,
    ),
  );
}
function suspendForm(token: string): Html {
  return h(
    'form',
    { method: 'post', action: confirmationAction },
    hidden('csrfToken', token),
    hidden('commandId', randomUUID()),
    hidden('kind', 'suspension'),
    hidden('action', 'suspend'),
    h(
      'label',
      null,
      'Scope',
      h(
        'select',
        { name: 'scope' },
        suspensionScopes.map((scope) => h('option', { value: scope }, scope)),
      ),
    ),
    field('id', 'Target ID (global uses *)'),
    field('version', 'Pinned version (optional)'),
    field('reason', 'Suspension reason'),
    field('expiresAt', 'Expiry ISO UTC (optional)'),
    h(
      'label',
      null,
      'Expected revision (0 for a new target)',
      h('input', { name: 'expectedRevision', type: 'number', min: 0, value: 0, required: true }),
    ),
    h('button', { type: 'submit' }, 'Review suspension'),
  );
}
function versionForm(token: string): Html {
  return h(
    'form',
    { method: 'post', action: confirmationAction },
    hidden('csrfToken', token),
    hidden('commandId', randomUUID()),
    hidden('kind', 'version'),
    h(
      'label',
      null,
      'Capability kind',
      h(
        'select',
        { name: 'capabilityKind' },
        ['agent', 'skill', 'tool'].map((kind) => h('option', { value: kind }, kind)),
      ),
    ),
    field('id', 'Capability ID'),
    field('version', 'Capability version'),
    field('reason', 'Version reason'),
    h(
      'label',
      null,
      'Version state',
      h(
        'select',
        { name: 'state' },
        ['draft', 'published', 'deprecated', 'revoked'].map((state) =>
          h('option', { value: state }, state),
        ),
      ),
    ),
    h(
      'label',
      null,
      'Version expected revision',
      h('input', { name: 'expectedRevision', type: 'number', min: 0, value: 0, required: true }),
    ),
    h('button', { type: 'submit' }, 'Review version change'),
  );
}
export function confirmationPage(form: URLSearchParams): string {
  return renderDocument(
    h(
      'main',
      null,
      h('h1', null, 'Confirm admin change'),
      h(
        'p',
        null,
        'Review the exact target, reason, expiry and revision. Revoked versions cannot be restored. Completed side effects are never replayed.',
      ),
      h(
        'dl',
        null,
        [...form.entries()]
          .filter(([key]) => key !== 'csrfToken')
          .map(([key, value]) => h('div', null, h('dt', null, key), h('dd', null, value))),
      ),
      h(
        'form',
        { method: 'post', action: '/admin/apply' },
        [...form.entries()].map(([key, value]) => hidden(key, value)),
        hidden('confirmed', 'yes'),
        h('button', { type: 'submit' }, 'Confirm change'),
      ),
      h('a', { href: '/admin' }, 'Cancel'),
    ),
  );
}
