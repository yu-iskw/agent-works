import { describe, expect, it } from 'vitest';

import { memoryPage } from './page.js';
import { webMemoryConsent, webMemoryItem } from './test-fixtures.js';
const token = 'a'.repeat(64);
describe('visible memory management', () => {
  it('shows consent, provenance, revision, expiry and controls', () => {
    const html = memoryPage(webMemoryConsent, [webMemoryItem()], token, 'Optional memory', {
      tenantEnabled: true,
    });
    for (const text of [
      'Your memory',
      'Optional memory',
      'Tenant memory: enabled',
      'Your consent: on',
      'Memory revision 1',
      'Origin task: task-1',
      'Classification: INTERNAL',
      'Expires:',
      'Save revision',
      'Delete memory',
      'Export your memories',
      'Opt out and delete memories',
    ])
      expect(html).toContain(text);
    expect(html).toContain('name="csrfToken"');
    expect(html).toContain('name="revision"');
  });
  it('defaults off with a clear enable action', () => {
    const html = memoryPage(
      { ...webMemoryConsent, enabled: false, revision: 0 },
      [],
      token,
      'Optional',
      { tenantEnabled: true },
    );
    expect(html).toContain('Your consent: off');
    expect(html).toContain('Enable memory');
    expect(html).toContain('No active memories.');
  });
  it('disables tenant opt-in when tenant policy is off', () => {
    const html = memoryPage({ ...webMemoryConsent, enabled: false }, [], token, 'Optional', {
      tenantEnabled: false,
    });
    expect(html).toContain('Tenant memory: disabled');
    expect(html).toContain('disabled');
  });
  it('escapes injected memory content and origin metadata', () => {
    const item = webMemoryItem();
    item.text = '<script>alert("x")</script>';
    item.origin.taskId = '"><img src=x onerror=alert(1)>';
    const html = memoryPage(webMemoryConsent, [item], token, '<img src=x>', {
      tenantEnabled: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });
  it('disables delete while under a legal hold', () => {
    const html = memoryPage(
      webMemoryConsent,
      [{ ...webMemoryItem(), legalHold: true }],
      token,
      'Optional',
      { tenantEnabled: true },
    );
    expect(html).toContain('Preserved under legal hold');
    expect(html).toContain('disabled');
  });
});
