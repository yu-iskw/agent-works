# UI milestone architecture

The binding contract is [`reference/IMPLEMENTATION_PROMPT.md`](reference/IMPLEMENTATION_PROMPT.md). This document records how the web layer and the segment API change to meet it, and why. Implementation deviations are appended to **Reconciliation** with who accepted them.

## Decision

A reactive client workspace (Preact 10 and `@preact/signals`, bundled by Vite into same-origin scripts under the existing `script-src 'self'` CSP) runs over a typed JSON API in the web BFF. The server renders a thin shell document with the theme already applied and a non-executing bootstrap JSON tag for the first view. The existing server-rendered M1 pages stay as the accessible fallback and as the home of catalog, connections, import and export.

Two designs were sketched in parallel. One kept the server as the only renderer and swapped HTML fragments with vanilla modules. The other is the shape above. The reactive island won on the interaction requirements (keyed timeline, focus and draft preservation under polling, composer menus and chips, panel routes) that a fragment-swap shell can meet only with per-region busy guards, which leave an in-use card stale. It costs three new packages and a second renderer for the fallback pages, which receive no new features. No cross-model judge was available: the repository forbids Sonnet and Opus subagents and Grok cannot be selected from Claude Code, so the base was picked on the written rubric by the coordinator.

Grafted from the fragment design:

- Persisted card anchors. `syncInbox` posts one `tw_messages` row per newly desired decision (`question`, `plan_review`, `approval`, `failed`, `uncertain`) in the same transaction, with `client_request_id = card:<taskId>:<ref>` so a replay is a no-op. The row fixes where the card sits in the timeline. What the card says is derived from current task state every time.
- Browser storage keys use a member tag, `sha256(sub)` truncated to 16 hex characters, never the subject itself.
- Reply state distinguishes queued from generating, from `tw_jobs`.
- Member files become evidence in passages of at most 2 KB with a line-range location.

## Module map

```text
packages/domain/src/
  teamwork.ts             list query and cursor schemas, result entries, teammate rows, attachments,
                          appearance, member_file source kind, attachmentIds on task scope and messages
  teamwork-timeline.ts    pure: timeline items and cards from a conversation page plus task details
apps/api/
  migrations/0021_ui_workspace.sql
  src/teamwork/           bounded lists, /results, conversation pages, read markers, card anchors,
                          appearance, attachments and the member_file read path
apps/web/
  shared/                 compiled into both server and client: route grammar, BFF contract types, labels
  app/workspace/          shell document, JSON routes, loaders, preferences store, recap, upload validation
  app/m1/                 existing pages, now the fallback
  client/workspace/       store (state, actions, pure reducer, selectors), effects, router, composer
                          routing, scroll anchoring, and ui/ components
```

`client/` cannot import `app/` and `app/` cannot import `client/`; both import `shared/` and `@agent-works/domain`. The client imports only the zod-free domain modules at runtime.

## Core shapes

- `Route = { segment, conversation, surface, panel }` is the only selection state. `PanelRoute` covers `none`, `inbox`, `preferences`, `teammate`, `draft`, `task`, `plan`, `approval`, `result {revision, view: result | sources | changes, citation, compareTo}` and `missing` (deleted or denied deep links). `parseRoute` and `formatRoute` are inverses and tested as such.
- `TimelineItem` is `day | message | system | contribution | card`. `Card` is `task_draft | running | question | plan | result | approval | failure`. Item ids are stable and content-free (`msg:<uuid>`, `card:<taskId>:<ref>`, `asg:<id>`), so polls and reconnects cannot duplicate or reorder.
- A result card names its own revision and the latest, so an old card links to the newer version without another fetch. An approval card carries `valid`, computed with the same checks `decideAction` makes (pending, same revision as latest, not expired); an invalid card shows why and cannot approve.
- `WorkspaceState` is one record of slices, each a signal. One pure `reduce(state, action)` returns the same slice references when nothing changed. Poll results never write `route`, drafts, panel reading positions or sidebar scroll.
- Status words come only from persisted facts: task status, the latest assignment and synthesis events, `tw_jobs` reply state. There is no progress number, no typing animation without a pending job, and no replayed text.

## Data flow

- **Boot.** `GET /s/<seg>/...` resolves the route (the startup preference decides `/s/<seg>`), loads the first view with the same loaders the JSON routes use, and renders the shell with `data-theme` (absent for System) and the bootstrap tag. The client purges browser keys belonging to any other member tag, then mounts.
- **Polling.** One timer, 2.5 s while visible, 8 s after three failures: `GET /api/s/<seg>/conversations/<id>?after=<cursor>` returns new items, reply state and linked task versions. A moved task version triggers one task-detail fetch.
- **Stale responses.** A segment switch is a full navigation. Within a document every request carries an epoch, and the reducer drops conversation and sidebar results from an older epoch. Every JSON reply echoes its segment and the client rejects a mismatch.
- **Posts.** JSON bodies with an `x-csrf-token` header that must equal the session token, plus the existing Origin allowlist and a JSON content-type requirement, so an HTML form cannot reach them. The form path keeps its `csrf` field. One `csrfOk` serves both.
- **Files.** One file per request as a raw body, at most 256 KB, text, Markdown, CSV or JSON, valid UTF-8. The BFF validates and forwards; the segment stores it in `tw_attachments`. Tasks read selected files through the `member_file` source kind into `wb_evidence` with provenance `MEMBER UPLOAD` and a sha256. Chat replies get a bounded excerpt inside an explicit untrusted-data block. The portable export allowlist is unchanged, so files never leave in exports.
- **Preferences.** `m1_preferences(sub, scope, key, value)` in `pg-web`. Member scope holds theme, startup view, send key and panel width. Segment scope holds the last context. Credentials are never stored there. Sign-out deletes the session and clears browser drafts, but keeps preferences.

## Real-model rule

Every conversation reply, plan, contribution, synthesis and revision in local acceptance goes through the existing model gate to Vertex `gemini-3.8-flash`. The UI milestone counts its calls under campaign `ui-2026-10` (migration `0020`), 300 per segment, concurrency 2 per segment. Real-model suites run one segment at a time, so at most two calls are in flight.

## Reconciliation

Empty until implementation.
