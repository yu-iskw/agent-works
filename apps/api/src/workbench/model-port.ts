type ModelMode = 'vertex' | 'stub';

export type GenerateRequest = {
  readonly system: string;
  readonly prompt: string;
  readonly jsonSchema?: unknown;
  /** The retrieved items the prompt describes; only the offline stub reads it. */
  readonly evidence?: readonly { readonly id: string; readonly title: string }[];
};

export type GenerateResult = {
  readonly text: string;
  readonly modelVersion: string;
  readonly responseId?: string;
  readonly latencyMs: number;
  readonly finishReason?: string;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
};

export interface ModelPort {
  readonly mode: ModelMode;
  readonly modelId: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export type ModelErrorCode =
  | 'adc_unavailable'
  | 'permission_denied'
  | 'api_disabled'
  | 'billing_disabled'
  | 'model_not_found'
  | 'rate_limited'
  | 'timeout'
  | 'unreachable'
  | 'unavailable'
  | 'bad_request'
  | 'empty_response'
  | 'invalid_output'
  | 'budget_exhausted'
  | 'not_configured';

export class ModelError extends Error {
  /** `sent` is false when the failure happened before any request left the process. */
  constructor(
    readonly code: ModelErrorCode,
    readonly sent = true,
  ) {
    super(code);
    this.name = 'ModelError';
  }
}

export const modelRemediation: Record<ModelErrorCode, string> = {
  adc_unavailable:
    'Application Default Credentials are missing or expired. Run `gcloud auth application-default login` on the host and restart the api service.',
  permission_denied:
    'The ADC identity lacks Vertex AI access. Grant roles/aiplatform.user on the project.',
  api_disabled: 'The Vertex AI API is disabled. Enable aiplatform.googleapis.com on the project.',
  billing_disabled: 'Billing is disabled for the project.',
  model_not_found:
    'The configured VERTEX_MODEL_ID is not available in this project and location. Check the model ID and GOOGLE_CLOUD_LOCATION.',
  rate_limited: 'Vertex AI quota or rate limit reached. Wait and retry.',
  timeout: 'The model call timed out. Retry the task.',
  unreachable: 'Vertex AI could not be reached from the api container. Check network access.',
  unavailable: 'Vertex AI returned a server error. Retry the task.',
  bad_request: 'Vertex AI rejected the request.',
  empty_response: 'The model returned no content. Retry the task.',
  invalid_output: 'The model output did not match the report contract. Retry the task.',
  budget_exhausted: 'The local model-call budget is exhausted. Raise WORKBENCH_MAX_MODEL_CALLS.',
  not_configured:
    'Vertex AI is not configured. Set GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and VERTEX_MODEL_ID.',
};
