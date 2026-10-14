import { capabilityVersionCommandSchema, suspensionCommandSchema } from '@agent-works/domain';

import type { CapabilityVersionCommand, SuspensionCommand } from '@agent-works/domain';
import type { IncomingMessage } from 'node:http';

export type AdminFormCommand =
  | { readonly kind: 'suspension'; readonly command: SuspensionCommand }
  | { readonly kind: 'version'; readonly command: CapabilityVersionCommand };
export async function readAdminForm(
  request: IncomingMessage,
): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size <= 16_384) chunks.push(bytes);
  }
  return size > 16_384 ? undefined : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
export function parseAdminForm(form: URLSearchParams): AdminFormCommand | undefined {
  const common = {
    commandId: form.get('commandId'),
    reason: form.get('reason'),
    expectedRevision: Number(form.get('expectedRevision')),
  };
  if (form.get('kind') === 'version') {
    const parsed = capabilityVersionCommandSchema.safeParse({
      ...common,
      pin: { kind: form.get('capabilityKind'), id: form.get('id'), version: form.get('version') },
      state: form.get('state'),
    });
    return parsed.success ? { kind: 'version', command: parsed.data } : undefined;
  }
  const expiry = form.get('expiresAt');
  const parsed = suspensionCommandSchema.safeParse({
    ...common,
    action: form.get('action'),
    target: { scope: form.get('scope'), id: form.get('id'), version: form.get('version') || null },
    expiresAt: expiry === null || expiry.length === 0 ? null : expiry,
  });
  return parsed.success ? { kind: 'suspension', command: parsed.data } : undefined;
}
