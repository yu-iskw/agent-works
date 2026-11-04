// Offline harness page: mounts the real GraphStatus component with a stub workspace context. The
// spec answers the graph routes itself, so no stack, model or network is involved.

import { render } from 'preact';

import { GraphStatus } from '../../../apps/web/client/workspace/ui/graph/graph-status.jsx';
import { WorkspaceContext } from '../../../apps/web/client/workspace/ui/context.js';

const store = {
  peek: () => ({ scope: { segment: 'alpha', csrf: 'csrf-token', memberTag: 'm' } }),
};
const mount = document.getElementById('root');
if (mount !== null)
  render(
    <WorkspaceContext.Provider value={{ store, effects: {} } as never}>
      <main>
        <h3>Task</h3>
        <GraphStatus taskId="11111111-1111-4111-8111-111111111111" />
      </main>
    </WorkspaceContext.Provider>,
    mount,
  );
