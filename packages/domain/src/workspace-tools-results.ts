import * as z from 'zod';

const label = z.string().min(1).max(512);
const text = z.string().max(100_000);

export const workspaceReceiptSchema = z.strictObject({
  id: label,
  kind: z.enum(['document', 'event', 'draft']),
});
export type WorkspaceReceipt = z.infer<typeof workspaceReceiptSchema>;
const workspaceSourceSchema = z.strictObject({
  id: label,
  title: text,
  body: text,
  classification: z.enum(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
});
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
export const workspaceSourcesSchema = z.array(workspaceSourceSchema).max(100);
