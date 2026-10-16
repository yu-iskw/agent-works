# 4. Adopt OpenBot's layout and interaction grammar for the web UI

Date: 2026-10-17

## Status

Proposed

## Context

RFC-001 sketches a Next.js frontend. ADR 0001 says that sketch is not binding. This file is repository record 0004. It is not the RFC section 3 note labeled ADR-004.

The live `apps/web` is a Node HTTP server. It rendered HTML strings through a hand-rolled JSX renderer in `apps/web/app/html.ts`. The app has one Ask page. It had no client JavaScript and no CSS.

OpenBot is a separate product in another repository. This team wants to reuse the layout and the interaction grammar of its web app. This record does not copy the OpenBot product.

## Decision

Build the web UI as a React client. Vite bundles that client. The existing `apps/web` Node server serves that client.

The browser calls the web server with `POST /api/ask` as JSON. The web server keeps IAP assertion forwarding and W3C `traceparent` propagation. The web server stays the only caller of `apps/api`.

The client takes the page frame and the prose column from OpenBot. It also takes the visual system. That system uses OKLCH colors for light and dark, the Inter font, and a 15px `html` root with the rem scaling note. While a question is pending, the answer area renders nothing and the submit button reads Asking…. The Ask screen has idle, pending, error, and success states only. Row kinds are captured in the web-screen-layout skill. Empty-state rules are captured in the web-data-access skill. Both apply to configuration screens that do not exist yet. The server owns authorization. Data access goes through factories.

OpenBot keeps coworkers, computers, plugins, the gallery, the playground, Better Auth, CopilotKit, AG-UI, Bun, its routing, and its component library.

The first slice ships only the shell, the theme, the Ask screen, and citations.

## Consequences

The web app gains a build step. `vite build` writes the client into `dist/client`.

This change removes the HTML form `POST /`, the HTML `GET /`, and `POST /citations`.

Two skills under `.claude/skills` encode the grammar for later screens.

The Next.js sketch in RFC-001 stays non-binding until a human accepts this record.

This record does not rewrite Accepted ADR 0001. This record does not rewrite RFC-001.

## Alternatives

The existing string renderer could be restyled. It cannot express dialogs, a detail pane, or streaming.

OpenBot could be forked. A fork brings the wrong product, a different toolchain, and a different set of licenses.

A shared design package could be extracted across both repositories. That package would couple the two products.
