import { askResponseSchema } from '@agent-works/domain/ask';
import { mutationOptions } from '@tanstack/react-query';

import { postJson } from '../client';

const askFailedMessage = 'The ask failed.';
const serviceUnavailableMessage = 'The service is unavailable.';

type AskInput = {
  readonly question: string;
};

async function postAsk(input: AskInput) {
  let response: Awaited<ReturnType<typeof postJson>>;
  try {
    response = await postJson('/api/ask', {
      requestId: crypto.randomUUID(),
      question: input.question,
    });
  } catch {
    throw new Error(serviceUnavailableMessage);
  }

  if (response.status === 200) {
    const parsed = askResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new Error(askFailedMessage);
    }
    return parsed.data;
  }

  throw new Error(messageFromPayload(response.payload));
}

function messageFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('message' in payload)) {
    return askFailedMessage;
  }
  const { message } = payload;
  return typeof message === 'string' ? message : askFailedMessage;
}

export function askMutationOptions() {
  // Ask has no cached read to invalidate.
  return mutationOptions({
    mutationFn: postAsk,
  });
}
