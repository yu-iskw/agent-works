import { h } from '../html.js';

import type { Html } from '../html.js';

export type ConnectionView = {
  readonly csrf: string;
  readonly status?: 'active' | 'revoked' | 'expired';
  readonly scope?: string;
  readonly message?: string;
};

export default function ConnectionsPage({ view }: { readonly view: ConnectionView }): Html {
  return (
    <main>
      <h1>Connections</h1>
      <a href="/">Ask</a>
      <h2>Google Drive</h2>
      <p role="status">{view.status ?? 'Not connected'}</p>
      {view.scope && <p>Scope: {view.scope}</p>}
      <form
        method="post"
        action={view.status === 'active' ? '/connections/disconnect' : '/connections/connect'}
      >
        <input type="hidden" name="csrf" value={view.csrf} />
        <button type="submit">{view.status === 'active' ? 'Disconnect' : 'Connect'}</button>
      </form>
      {view.message && <p role="alert">{view.message}</p>}
    </main>
  );
}
