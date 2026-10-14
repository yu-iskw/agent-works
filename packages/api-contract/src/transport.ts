import { validateOperationBody, validateOperationHeaders, validateResponse } from './validation.js';
export type ClientOptions = {
  readonly baseUrl: string;
  readonly assertion?: string;
  readonly fetch?: typeof fetch;
};
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API request failed (${status}): ${code}`);
    this.name = 'ApiClientError';
  }
}
export class ContractTransport {
  private readonly options: ClientOptions;
  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('invalid API base URL');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('API requires HTTPS');
    this.options = { ...options, baseUrl: url.origin };
  }
  async request<T>(
    operationId: string,
    method: string,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<T> {
    if (
      !validateOperationBody(operationId, body) ||
      !validateOperationHeaders(operationId, headers)
    )
      throw new ApiClientError(400, 'invalid_request');
    const fixed: Record<string, string> = { ...headers, 'content-type': 'application/json' };
    if (this.options.assertion !== undefined)
      fixed['x-goog-iap-jwt-assertion'] = this.options.assertion;
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.baseUrl), {
      method,
      headers: fixed,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch {
      throw new ApiClientError(response.status, 'invalid_response');
    }
    if (!response.ok) throw new ApiClientError(response.status, errorCode(value));
    if (!validateResponse(operationId, response.status, value))
      throw new ApiClientError(response.status, 'invalid_response');
    return value as T;
  }
}
function errorCode(value: unknown): string {
  if (
    value !== null &&
    typeof value === 'object' &&
    'error' in value &&
    typeof value.error === 'string' &&
    /^[a-z_]{1,64}$/.test(value.error)
  )
    return value.error;
  return 'request_failed';
}
