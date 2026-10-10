import { Fragment, h } from './html.js';

import type { Html } from './html.js';
import type { AskResponse } from '@agent-works/domain';

export type PageView =
  | { readonly kind: 'ready'; readonly requestId: string }
  | {
      readonly kind: 'answered';
      readonly requestId: string;
      readonly question: string;
      readonly response: AskResponse;
    }
  | {
      readonly kind: 'failed';
      readonly requestId: string;
      readonly question: string;
      readonly message: string;
    };

export default function Page({ view }: { readonly view: PageView }): Html {
  return (
    <main>
      <h1>Ask</h1>
      <form method="post" action="/">
        <label for="question">Question</label>
        <input id="question" name="question" required maxlength={1000} />
        <input type="hidden" name="requestId" value={view.requestId} />
        <button type="submit">Ask</button>
      </form>
      {view.kind === 'answered' && (
        <>
          <p>{view.response.answer}</p>
          <ol aria-label="Citations">
            {view.response.citations.map((citation) => (
              <li>
                <a href={citation.sourceUri}>{citation.title}</a>
              </li>
            ))}
          </ol>
        </>
      )}
      {view.kind === 'failed' && <p role="alert">{view.message}</p>}
    </main>
  );
}
