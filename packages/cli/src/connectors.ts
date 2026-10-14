import { connectorOutput } from './connectors-output.js';
import { parseConnectorSummaries } from './connectors-schema.js';
import { connectorApiUrl } from './connectors-url.js';

type ConnectorCliOptions = {
  readonly assertion?: string;
  readonly fetch?: typeof fetch;
  readonly apiUrl?: string;
};
type Writer = { write(text: string): unknown };
/** Use the existing caller-filtered OAuth summaries; never print token references or secrets. */
export async function runConnectors(
  args: readonly string[],
  output: Writer,
  options: ConnectorCliOptions = {},
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== 'list')) {
    output.write('Usage: aw connectors [list]\n');
    return 2;
  }
  if (!options.assertion) {
    output.write('Authentication required.\n');
    return 1;
  }
  try {
    const response = await (options.fetch ?? fetch)(
      connectorApiUrl(options.apiUrl ?? 'http://127.0.0.1:8084'),
      {
        headers: { 'x-goog-iap-jwt-assertion': options.assertion },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) {
      output.write(
        response.status === 401 ? 'Authentication required.\n' : 'Connectors unavailable.\n',
      );
      return 1;
    }
    const parsed = parseConnectorSummaries((await response.json()) as unknown);
    if (!parsed) throw new Error('invalid response');
    output.write(connectorOutput(parsed));
    return 0;
  } catch {
    output.write('Connectors unavailable.\n');
    return 1;
  }
}
