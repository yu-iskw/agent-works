export type ConnectorSummary = {
  readonly provider: string;
  readonly scope: string;
  readonly status: string;
};
export function parseConnectorSummaries(value: unknown): readonly ConnectorSummary[] | undefined {
  if (typeof value !== 'object' || value === null || !('connections' in value)) return undefined;
  if (!Array.isArray(value.connections)) return undefined;
  const rows: ConnectorSummary[] = [];
  for (const row of value.connections as unknown[]) {
    const parsed = parseSummary(row);
    if (!parsed) return undefined;
    rows.push(parsed);
  }
  return rows;
}
function parseSummary(value: unknown): ConnectorSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fields = new Map<string, unknown>(Object.entries(value));
  const provider = fields.get('provider'),
    scope = fields.get('scope'),
    status = fields.get('status');
  if (typeof provider !== 'string' || typeof scope !== 'string' || typeof status !== 'string')
    return undefined;
  if (!['active', 'expired', 'revoked'].includes(status)) return undefined;
  return { provider, scope, status };
}
