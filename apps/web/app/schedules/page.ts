import { h, renderDocument } from '../html.js';

import type { ScheduleRecord, ScheduleSpec } from '../../../../packages/domain/dist/schedule.js';
import type { Html } from '../html.js';
const schedulesPath = '/schedules';
function hidden(name: string, value: string | number): Html {
  return h('input', { type: 'hidden', name, value });
}
export function schedulesPage(
  rows: readonly ScheduleRecord[],
  token: string,
  message?: string,
): string {
  return renderDocument(
    h(
      'main',
      null,
      h(
        'nav',
        { 'aria-label': 'Main' },
        h('a', { href: '/' }, 'Ask'),
        ' ',
        h('a', { href: schedulesPath, 'aria-current': 'page' }, 'Schedules'),
      ),
      h('h1', null, 'Scheduled tasks'),
      message === undefined ? null : h('p', { role: 'status' }, message),
      h(
        'p',
        null,
        'Tasks run within your current authority, consent, expiry and allowed time window. Pausing cancels in-flight work.',
      ),
      h(
        'table',
        null,
        h('caption', null, 'Your schedules'),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...['Purpose', 'Skill', 'State', 'Expiry', 'Actions'].map((v) =>
              h('th', { scope: 'col' }, v),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) => scheduleRow(row, token)),
        ),
      ),
      rows.length === 0 ? h('p', null, 'No schedules yet.') : null,
      h('h2', null, 'Create schedule'),
      h(
        'p',
        null,
        'Paste a schedule specification. Review the privilege preview before saving. Consent must already exist in the trusted local registry.',
      ),
      h(
        'form',
        { method: 'post', action: '/schedules/preview' },
        hidden('csrfToken', token),
        h('label', { for: 'schedule-spec' }, 'Schedule specification (JSON)'),
        h('textarea', { id: 'schedule-spec', name: 'spec', rows: 20, cols: 80, required: true }),
        h('button', { type: 'submit' }, 'Preview privileges'),
      ),
      h('p', null, h('a', { href: schedulesPath }, 'Reload schedules')),
    ),
  );
}
function scheduleRow(row: ScheduleRecord, token: string): Html {
  const spec = row.spec;
  return h(
    'tr',
    null,
    h('td', null, spec.purpose),
    h('td', null, `${spec.maxPrivilege.skill.id}@${spec.maxPrivilege.skill.version}`),
    h('td', null, row.state),
    h('td', null, spec.expiresAt),
    h(
      'td',
      null,
      row.state === 'revoked'
        ? null
        : h(
            'form',
            { method: 'post', action: '/schedules/change' },
            hidden('csrfToken', token),
            hidden('id', spec.id),
            hidden('revision', row.revision),
            hidden('action', row.state === 'active' ? 'pause' : 'resume'),
            h('button', { type: 'submit' }, row.state === 'active' ? 'Pause' : 'Resume'),
          ),
    ),
  );
}
export function schedulePreviewPage(spec: ScheduleSpec, preview: unknown, token: string): string {
  const allowed =
    preview !== null &&
    typeof preview === 'object' &&
    'allowed' in preview &&
    preview.allowed === true;
  return renderDocument(
    h(
      'main',
      null,
      h('h1', null, 'Schedule privilege preview'),
      h(
        'p',
        null,
        allowed
          ? 'The ceiling is within your current authority. Creation rechecks authority and consent.'
          : 'The ceiling exceeds your current authority.',
      ),
      h(
        'dl',
        null,
        ...Object.entries(spec.maxPrivilege).map(([key, value]) =>
          h(
            'div',
            null,
            h('dt', null, key),
            h('dd', null, typeof value === 'string' ? value : JSON.stringify(value)),
          ),
        ),
      ),
      h('p', null, `Purpose: ${spec.purpose}`),
      h('p', null, `Consent reference: ${spec.consentRef}`),
      allowed
        ? h(
            'form',
            { method: 'post', action: '/schedules/create' },
            hidden('csrfToken', token),
            hidden('spec', JSON.stringify(spec)),
            h('button', { type: 'submit' }, 'Create schedule'),
          )
        : null,
      h('a', { href: schedulesPath }, 'Back to schedules'),
    ),
  );
}
