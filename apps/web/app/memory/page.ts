import { h, renderDocument } from '../html.js';

import type { MemoryConsent, MemoryItem } from '@agent-works/domain/user-memory';
function hidden(name: string, value: string | number) {
  return h('input', { type: 'hidden', name, value });
}
export function memoryPage(
  consent: MemoryConsent,
  items: readonly MemoryItem[],
  token: string,
  notice: string,
  options: { tenantEnabled: boolean; message?: string },
): string {
  return renderDocument(
    h(
      'main',
      null,
      h('h1', null, 'Your memory'),
      h('p', null, notice),
      h(
        'p',
        null,
        `Tenant memory: ${options.tenantEnabled ? 'enabled' : 'disabled'}. Your consent: ${consent.enabled ? 'on' : 'off'}.`,
      ),
      h('p', { role: 'status' }, options.message ?? ''),
      h(
        'form',
        { method: 'post', action: '/memory/consent' },
        hidden('csrfToken', token),
        hidden('revision', consent.revision),
        hidden('enabled', String(!consent.enabled)),
        h(
          'button',
          { type: 'submit', disabled: !options.tenantEnabled && !consent.enabled },
          consent.enabled ? 'Opt out and delete memories' : 'Enable memory',
        ),
      ),
      h('a', { href: '/memory/export' }, 'Export your memories'),
      h(
        'section',
        { 'aria-label': 'Your memories' },
        items.length === 0
          ? h('p', null, 'No active memories.')
          : items.map((item) => memoryRow(item, token)),
      ),
    ),
  );
}
function memoryRow(item: MemoryItem, token: string) {
  return h(
    'article',
    null,
    h('h2', null, `Memory revision ${item.revision}`),
    h('p', null, item.text),
    h(
      'p',
      null,
      `Agent: ${item.agent}. Expires: ${item.expiresAt}. Origin task: ${item.origin.taskId}. Classification: ${item.classification}.`,
    ),
    h(
      'form',
      { method: 'post', action: '/memory/edit' },
      hidden('csrfToken', token),
      hidden('id', item.id),
      hidden('agent', item.agent),
      hidden('revision', item.revision),
      h(
        'label',
        null,
        'Memory text',
        h('textarea', { name: 'text', maxlength: 2048, required: true }, item.text),
      ),
      h('button', { type: 'submit' }, 'Save revision'),
    ),
    h(
      'form',
      { method: 'post', action: '/memory/delete' },
      hidden('csrfToken', token),
      hidden('id', item.id),
      hidden('agent', item.agent),
      hidden('revision', item.revision),
      h(
        'button',
        { type: 'submit', disabled: item.legalHold },
        item.legalHold ? 'Preserved under legal hold' : 'Delete memory',
      ),
    ),
  );
}
