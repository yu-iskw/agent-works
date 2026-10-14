import type { ConnectorSummary } from './connectors-schema.js';
export function connectorOutput(rows: readonly ConnectorSummary[]): string {
  const lines = ['Provider\tStatus\tScopes'];
  for (const row of rows)
    lines.push(
      `${safe(row.provider)}\t${row.status}\t${row.scope.split(/\s+/).filter(Boolean).map(safe).sort().join(' ')}`,
    );
  if (!rows.length) lines.push('No connected providers.');
  return lines.join('\n') + '\n';
}
function safe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}
