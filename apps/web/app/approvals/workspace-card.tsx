import { h } from '../html.js';

import type { Html } from '../html.js';
export type WorkspaceApprovalPayload =
  | {
      readonly tool: 'docs.createDraft';
      readonly title: string;
      readonly destinationId: string;
      readonly body: string;
    }
  | {
      readonly tool: 'calendar.createEvent';
      readonly summary: string;
      readonly calendarId: string;
      readonly description: string;
      readonly start: string;
      readonly end: string;
      readonly attendees: readonly string[];
    }
  | {
      readonly tool: 'gmail.createDraft';
      readonly subject: string;
      readonly to: readonly string[];
      readonly body: string;
    };
export type WorkspaceCardProps = {
  readonly payload: WorkspaceApprovalPayload;
  readonly previous?: WorkspaceApprovalPayload;
  readonly payloadSha256: string;
};
export function WorkspaceApprovalCard({
  payload,
  previous,
  payloadSha256,
}: WorkspaceCardProps): Html {
  return (
    <section aria-label="Workspace action payload">
      <h2>Review workspace draft</h2>
      <p>
        {payload.tool === 'calendar.createEvent'
          ? 'Create this event. Attendee notifications are disabled.'
          : 'Create this draft.'}
      </p>
      <p>Approval authorizes this exact payload once.</p>
      <dl>
        <dt>Payload SHA-256</dt>
        <dd>
          <code>{payloadSha256}</code>
        </dd>
      </dl>
      <table aria-label="Workspace payload changes">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {fields(payload).map(([name, value]) => (
            <tr>
              <th>{name}</th>
              <td>
                {previous ? (new Map(fields(previous)).get(name) ?? 'Not present') : 'Not present'}
              </td>
              <td>
                <pre>{value}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function fields(payload: WorkspaceApprovalPayload): readonly (readonly [string, string])[] {
  switch (payload.tool) {
    case 'docs.createDraft':
      return [
        ['Title', payload.title],
        ['Destination', payload.destinationId],
        ['Body', payload.body],
      ];
    case 'calendar.createEvent':
      return [
        ['Calendar', payload.calendarId],
        ['Summary', payload.summary],
        ['Description', payload.description],
        ['Start', payload.start],
        ['End', payload.end],
        ['Attendees', payload.attendees.join(', ')],
      ];
    case 'gmail.createDraft':
      return [
        ['Subject', payload.subject],
        ['To', payload.to.join(', ')],
        ['Body', payload.body],
      ];
  }
}
