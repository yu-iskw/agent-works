# 4. Adopt OpenBot's layout and interaction grammar for the web UI

Date: 2026-10-17

## Status

Proposed

## Context

RFC-001 sketches a Next.js frontend. ADR 0001 says that sketch is not binding. This file is repository record 0004. It is not the RFC section 3 note labeled ADR-004.

The live `apps/web` is a Node HTTP server. It rendered HTML strings through a hand-rolled JSX renderer in `apps/web/app/html.ts`. That page was one Ask form. It had no client JavaScript and no CSS.

OpenBot is a separate product in another repository. This team wants to reuse the layout and the interaction grammar of its web app. This record does not copy the OpenBot product.

## Decision

Build the web UI as a React client. Vite bundles that client. The existing `apps/web` Node server serves that client.

The browser calls the web server with `POST /api/ask`. The JSON body has `requestId` and `question`. The web server keeps IAP assertion forwarding and W3C `traceparent` propagation. The web server stays the only caller of `apps/api`.

The client takes the visual system from OpenBot. That system uses OKLCH colors for light and dark, the Inter font, and a 15px `html` root. The shell is a sidebar of questions, a header, a conversation section, and a composer. Below 768px an open sidebar is an overlay. At 768px and above an open sidebar docks.

Thread state is a pure reducer in `apps/web/client/lib/threads/state.ts`. The states are empty, pending, answered, and failed, per thread. Empty means the thread has no turns. A turn is pending, answered, or failed. A pending turn moves to answered or to failed. A failed turn can retry. Retry is the only path back to pending, and that retry carries a new request id. The caller mints one request id per attempt. The reducer stores the id it is given.

Pending renders a status line with `role=status`. The line reads Searching the documents. The shared Button is `apps/web/client/components/ui/button.tsx`. Variant classes and size classes come from lookup tables. No other shared control is introduced. The server owns authorization. Data access goes through factories.

The web-screen-layout skill records the shell and the Button. The web-data-access skill records the reducer, the request id rule, and the `/api/ask` body. OpenBot keeps coworkers, computers, plugins, the gallery, the playground, Better Auth, CopilotKit, AG-UI, Bun, its routing, and its component library.

The first slice ships the shell, the theme, the conversation, and citations.

## Consequences

The web app gains a build step. `vite build` writes the client into `dist/client`.

This change removes the HTML form `POST /`, the HTML `GET /`, and `POST /citations`.

Two skills under `.claude/skills` record the shell, the Button, and the thread reducer.

Thread history is in memory only and is lost on reload. This is a known limit.

The Next.js sketch in RFC-001 stays non-binding until a human accepts this record.

This record does not rewrite Accepted ADR 0001. This record does not rewrite RFC-001.

## Alternatives

The existing string renderer could be restyled. It cannot express dialogs, a detail pane, or streaming.

OpenBot could be forked. A fork brings the wrong product, a different toolchain, and a different set of licenses.

A shared design package could be extracted across both repositories. That package would couple the two products.
