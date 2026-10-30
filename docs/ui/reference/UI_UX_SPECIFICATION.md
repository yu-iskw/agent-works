# Agent Works: Conversation-centered UI and UX milestone

Decision date: 30 October 2026. Based on ten UI discovery answers, the supplied Grok Bot screenshots and handbook, official Grok Bot documentation, and merged PR #178 at `7c51edf0303e1df9ce3a1cf4dd5ef41fb8bc0643`.

## 1. Intent and issue analysis

**Stated goal:** Bring Agent Works closer to the Grok Bot UI and make interaction and conversation with teammate bots enjoyable.

**Underlying goal:** A member should recognize their teammates, talk naturally, delegate useful work, stay oriented while it runs, inspect results, and continue the same conversation without administrative friction.

**XY check:** Matching colors and rounded bubbles is insufficient when the product still sends the member into separate configuration and task pages. The most consequential improvement is continuity between conversation, delegation, decisions, and artifacts. Visual design should reinforce that continuity.

### Current baseline and limits of this review

PR #178 provides persisted teammate conversations, task assignments, reviewed coordinator plans, parallel workers, an inbox, citations, revisions, publication approvals, catalog customization, and two segment backends. The merged acceptance report records a later scope change: source systems and identity remain simulated; Gemini is real. Visual baseline approval and independent usability review moved into the UI/UX milestone, and live integrations were deferred.

The current `ConversationPanel` explicitly says conversations cannot read sources and directs members to a separate task form. Teammate details place capabilities and skills beside the chat; task detail places decisions, results, assignments, evidence, discussion, and activity in a long document. The handoff reports long mobile task pages and an inbox that grows without pagination. These are documented/code-derived findings, not a new live-browser usability assessment.

The screenshots supplied by the member are Grok reference images, not evidence of Agent Works' current appearance. They show recognizable avatars, a conversation list, restrained surfaces, short exchanges, compact outcome summaries, and handoffs attributed to teammates.

## 2. Confirmed design decisions

| Question | Answer | Binding UI direction                                                                                                           |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1        | C      | Conversation-first screen with an adaptive side panel.                                                                         |
| 2        | C      | Switchable sidebar views: Teammates, Work, Results.                                                                            |
| 3        | C      | Equally polished light and dark themes, system-aware with manual override.                                                     |
| 4        | C      | Grok-style bubbles plus distinct cards for work, results, questions, and approvals.                                            |
| 5        | C      | Minimal composer with removable chips for selected context; discovery through +, @, and /.                                     |
| 6        | C      | Teammate rows combine message preview with a separate work/attention indicator.                                                |
| 7        | C      | Resizable conversation/result split with an expanded reading mode and preserved position.                                      |
| 8        | C + A  | Shared timeline with each actual sender's identity; detailed contributions and handoffs collapse.                              |
| 9        | C      | Curated original avatars with customizable name, accent color, and short role label.                                           |
| 10       | D      | Configurable startup view: last conversation, attention inbox, or coordinator recap; last conversation is the initial default. |

## 3. Approaches and evaluation

All approaches below aim to implement the agreed behavior. These scores are comparative planning judgments, not measured usability results. No delivery duration is asserted.

| Criterion                      | Weight | Meaning                                                                                        |
| ------------------------------ | -----: | ---------------------------------------------------------------------------------------------- |
| Conversation continuity        |    30% | Smooth transition from talking to work, review, and follow-up without losing context.          |
| Visual and interaction quality |    20% | Faithfulness to the chosen experience, accessibility, responsive layout, and control behavior. |
| State and trust integrity      |    20% | Reuses authoritative task/approval state and preserves member/segment boundaries.              |
| Delivery feasibility           |    20% | Implementation burden, migration risk, and useful increments in this repository.               |
| Maintainability                |    10% | Component reuse and a manageable path for richer interactions later.                           |

| Approach                             | Description                                                                                                                             | Benefit                                                     | Cost                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. Improve current pages             | Retain page-oriented navigation, add consistent components and overlays, and restore UI state across navigation.                        | Low disruption; straightforward reuse.                      | Maintaining conversational continuity across pages remains harder.                                               |
| 2. Unified conversation shell        | Compose the current server-rendered views into a common shell; add focused browser behavior for sidebar, composer, timeline, and panel. | Strong fit with existing contracts and the selected design. | Requires explicit client view-state and focus management.                                                        |
| 3. Shell with interactive components | Use the common shell, but give the composer, timeline, and panels dedicated reactive components.                                        | Easier implementation of complex interactive state.         | Introduces a new component/runtime boundary and migration work.                                                  |
| 4. Full frontend replacement         | Rebuild the experience as a complete client application over existing APIs.                                                             | Maximum layout and navigation flexibility.                  | Largest migration and regression surface before useful delivery.                                                 |
| 5. Adapt an external chat UI toolkit | Use a toolkit for the conversation surface and map Agent Works events into it.                                                          | Can accelerate common chat controls.                        | Task, approval, revision, and isolation semantics still need careful integration; visual constraints may remain. |

| Approach | Continuity | Quality | State/trust | Delivery | Maintainability | Weighted score |
| -------- | ---------: | ------: | ----------: | -------: | --------------: | -------------: |
| 1        |         75 |      80 |          90 |       88 |              78 |           81.9 |
| **2**    |     **94** |  **90** |      **92** |   **80** |          **86** |       **89.2** |
| 3        |         96 |      93 |          85 |       64 |              88 |           87.0 |
| 4        |         95 |      94 |          72 |       40 |              84 |           78.1 |
| 5        |         85 |      78 |          70 |       72 |              65 |           76.0 |

**Recommendation:** Begin with approach 2. Build one real conversation-to-result prototype using existing task and approval contracts before expanding every screen. If the timeline/composer/panel state becomes difficult to maintain, adopt approach 3 for those components. Do not let an unconditional framework preference prevent the agreed interaction quality.

Approach 3 is a strong second choice if the team already has a supported frontend component stack or the prototype demonstrates that richer client state is essential. A full replacement becomes more reasonable only with a separately justified migration budget and regression plan.

## 4. Recommended UI specification

### A. One continuous workspace

Use three regions on a sufficiently wide desktop: switchable sidebar, conversation, contextual panel. The panel is closed until useful. The conversation remains the default working surface.

The header shows the current teammate or task, its identity and concise status, an obvious details control, and the active segment. Settings, catalog management, and connection troubleshooting remain reachable without dominating every conversation.

Preserve existing URLs and task records. A task can have a dedicated deep link while opening within this workspace. Full-page fallbacks are valid on small screens or without enhancement; they should not create separate copies of work.

### B. Sidebar that changes purpose without becoming crowded

Place Search and a clear New control above three text-labeled tabs:

- **Teammates:** familiar roster with avatar, name, latest message preview, time, and a separate state indicator.
- **Work:** scoped task list with filters for running, needs attention, and completed work, plus search and bounded pagination.
- **Results:** searchable artifact/revision entries with title, producing teammate, task, and updated time. Open the selected artifact in the panel.

Keep selection and scroll position for each tab. A tab change does not clear the composer, change the active conversation, or switch segments. Catalog, Connections, Preferences, and account actions can live in a clear workspace/account menu. Inbox access must remain one action away and advertise outstanding decisions even while another tab is open.

Results is a view over existing artifacts and revisions; it does not require a new document storage or sharing platform. A search result must land on the actual message/task/artifact, not merely reopen its parent screen.

Distinguish three concepts: unread activity, ongoing execution, and a required member decision. Opening a conversation can clear unread state, but must never resolve an unanswered question or approval. Do not indicate these states with color alone.

### C. Conversation rhythm

Use rounded, low-contrast teammate bubbles aligned left and contrasting member bubbles aligned right. Keep readable line lengths, generous but controlled spacing, and a clear hierarchy for sender, content, and time.

Group consecutive messages by the same sender where appropriate; avoid repeating a large avatar and timestamp on every line. Show a new sender clearly in shared task timelines. Use original assets rather than Grok's branding or avatar artwork.

Represent these as distinct compact cards in the timeline:

| Card                     | Main view                                                                | Expanded details                                                        |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Task draft               | Objective, selected scope, specialists, mode, Start/Edit actions.        | Assignment and source choices.                                          |
| Running work             | Actual stage, owner, contribution count, useful next action.             | Assignment status and observed activity.                                |
| Question                 | The missing decision, relevant context, answer controls.                 | Supporting evidence when needed.                                        |
| Coordinator plan         | Short assignment summary and Review plan action.                         | Exact version, assignments, dependencies, capabilities, approve/reject. |
| Result                   | Title, concise outcome, revision, unresolved points, Open result action. | Full artifact, evidence, comparison, publication.                       |
| Action approval          | Operation, destination/account, reviewed revision, Review action.        | Exact content and consequences before approval.                         |
| Failure/uncertain action | What stopped, what is known to have happened, recovery action.           | Diagnostic/support details and reconciliation.                          |

Cards should expose the next useful action without duplicating the full task page inside every bubble. Keep prior result cards linked to their original revision, with a clear link to a newer one. Label stale approvals and disable invalid actions.

### D. A composer that can lead into work

Use an expanding multiline composer with + and Send controls. Selected files, teammates, skills, and sources appear as removable, readable context chips. Keep unused features in menus.

`@` discovers authorized teammates and sources. `/` discovers applicable skills and supported actions. Menus need keyboard navigation, escape behavior, clear empty states, and understandable disabled reasons. Suggestions must be segment- and member-scoped.

The critical improvement over current M1: a member can prepare a source-backed task from the conversation without filling the entire separate new-task page. Initially expose an explicit **Create task** action in + or a suggested task-draft card. The member reviews the scope and starts manual work or requests a coordinator plan using existing backend authorization.

Natural-language intent detection can suggest a draft; it must not silently dispatch work or pretend ordinary chat already inspected sources. Asking a source question should produce a clear route to authorized work, not a fabricated answer. Keep an advanced assignment editor available in the contextual panel.

Support correcting and continuing an active task in the same conversation. Reflect whether a message is an answer, revision request, or a new task. When routing is ambiguous, ask a focused clarification.

File chips must represent actual supported attachment processing. If it is not implemented, expose a clear supported alternative or disabled state; do not add a decorative upload button that discards data. Keep attachment ingestion bounded and separate from portable teammate definitions.

Recommended keyboard behavior: Enter sends, Shift+Enter adds a newline, with a visible preference for members who prefer Ctrl/Cmd+Enter. Preserve existing shortcuts during transition where practical. Enter during input-method composition must not submit. File uploads and pending send states need cancellation/error recovery.

### E. Resizable review panel

Opening a card shows its actual content in the contextual panel. For artifacts, provide Result, Sources, and Changes views; detailed activity can be a secondary section. Avoid many permanent tabs that are irrelevant to the selection.

Use a keyboard-accessible resize separator, sensible minimum widths, an Expand control, and a visible Close control. Remember width as a member preference, but clamp it to the current viewport. Expanded mode preserves the transcript, draft, selection, and prior scroll positions.

Selecting a citation opens the exact source entry/passage. Returning to the result restores the reading position. Changing a revision updates its sources and comparison context together. Approval content must refer to the exact revision on which the action is based.

At tablet widths, allow the panel to take the primary content area with a clear Back to conversation action. On phones, show one working surface at a time; never squeeze three narrow columns together. Sidebars and panels use accessible overlays or routes with reliable focus return and browser Back behavior.

### F. Shared timeline with controlled density

Show actual specialist contributions with their own name/avatar and the coordinator's actual summaries. Expandable sections contain longer contributions, detailed handoffs, and supporting activity. Keep important questions and approvals visible regardless of collapse state.

Use existing assignment/task relationships to assemble the timeline. Do not fabricate agent-to-agent banter, invent conversations from activity labels, or introduce autonomous group orchestration merely to resemble the reference screenshots. An assignment's completed contribution is a valid attributed card.

If work is queued, say queued. If a worker is executing a known stage, show that stage. Only show typing/generation animation while there is a real corresponding generation event. Streaming must reflect provider output; do not replay completed prose as pretend live tokens.

Auto-scroll only when the member is already following the bottom. When they are reading earlier messages, show a New activity control and preserve position. Late-arriving contributions need stable order and deduplication across reconnects.

### G. Teammate identity and profile

Provide a curated original avatar set, editable display name, short role label, and accent selection. Avatar/name identity remains consistent across sidebar, header, mentions, assignment cards, and result attribution.

Keep identity accents limited to avatars, mentions, and small highlights. Preserve separate consistent semantic colors for errors, success, and attention; segment identification must remain explicit. Avoid turning every bubble or panel into a competing identity color.

Open teammate details from the header. Place capabilities, skills, private preferences, and export actions here with clear editing scopes. An avatar/name change must not alter capabilities, templates, or another member's teammate instance.

If custom image upload is included, handle file validation and image processing; otherwise an avatar picker and initials are sufficient. Do not export uploaded private imagery or conversation-derived identity material by accident.

### H. Appearance and startup preferences

Offer System, Light, and Dark modes with equivalent contrast and semantic states, no theme flash, and a persisted member preference. Test custom accent contrast in both themes.

Offer three starting views: Last conversation, Attention inbox, and Coordinator recap. Initial default: Last conversation. Restore the last accessible segment, conversation, scroll position, unsent draft, active sidebar tab, and open result panel where safe.

A coordinator recap can initially be a concise UI summary derived from persisted task/inbox state with links. Generative recaps are optional and must remain grounded in current authorized state; they must not fabricate proactive messages or start work.

If the previous member, segment entitlement, teammate, or artifact is unavailable, restore a safe accessible view with an explanation. Persist drafts and UI context under member-and-segment keys, not a segment-only key that could expose drafts after account switching on a shared browser. Clear or isolate protected state on sign-out.

## 5. Incremental delivery plan

| Stage                      | Outcome                                                                                               | Acceptance emphasis                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1. Shell and identity      | Themes, sidebar tabs, teammate rows, personalization, configurable startup.                           | Responsive navigation, accessible identity and state, safe state restoration. |
| 2. Conversation-to-work    | Composer chips/menus, shared timeline, task-draft cards, existing manual and reviewed-plan execution. | Start useful work without leaving the workspace; preserve authorization.      |
| 3. Review and recovery     | Resizable/expanded artifact panel, citations, revisions, plan/action review, recoverable error cards. | No context loss; exact approval/version behavior; concise mobile views.       |
| 4. Evidence and refinement | Real-model journeys, reviewed visual comparisons, independent human sessions, focused repairs.        | Actual usability and polished behavior under both themes and varied content.  |

Fix shared UI helpers and typed error presentation opportunistically as the relevant components change. Avoid making every repository cleanup a prerequisite to the user-visible flow.

## 6. Acceptance criteria

### Core experience

1. All ten decisions are visibly implemented in a single coherent workspace.
2. A member customizes a teammate, attaches a skill, prepares and starts work, observes real parallel contributions, opens a result, inspects a citation, requests a substantive revision, compares revisions, and resolves an approval without losing the conversation or using the long standalone form for the normal path.
3. Manual assignment and version-bound coordinator review still work. Task-draft creation and plan review do not imply permission for external publication.
4. Teammates, Work, and Results sidebar views are searchable/bounded, preserve their own position, and open the actual selected object. Test realistic accumulated data, not only an empty installation.
5. Working, unread, and needs-attention states remain distinct and consistent with persisted backend state. Resolved actions update everywhere, including after refresh/reconnect.
6. The panel can open, resize by pointer and keyboard, expand, switch source/revision context, and close with correct position/focus restoration.
7. Light/dark/system appearance, identity customization, and startup choice persist correctly for the current member.
8. Drafts, context chips, last-view settings, cached results, and delayed responses cannot cross member/segment boundaries. Segment switching does not cancel existing backend work unless explicitly requested.

### E2E and visual evidence

Run the application and browser tests locally through Compose. Preserve the current mock-source/identity scope as documented in merged M1; do not label it live external access. Use the real configured Vertex Gemini for conversational/assignment acceptance. Deterministic rendered states can support screenshot regression, labeled separately from real-model journeys.

Required evidence:

- Research, metric, and engineering conversation-to-result journeys; cover both segments, both themes, manual assignment, and reviewed coordination across the suite. Do not require every cross-product combination to spend real calls when targeted tests establish the behavior.
- One complete keyboard-only conversation-to-review journey, including command/mention menus, context removal, panel resize/close, and approval review.
- Responsive checks at approximately 375, 768, and 1440 CSS pixels, with long messages, titles, task histories, errors, and multiple teammates. No horizontal page overflow, hidden primary actions, clipped panels, or unbounded inbox rendering.
- User reading earlier messages is not dragged to the bottom; New activity works; scroll and drafts survive appropriate navigation/reload. Input-method Enter does not submit prematurely.
- Runtime updates preserve selected source, artifact revision, focused control, and unsent text. Old approval cards cannot approve a changed revision.
- Accessible names, focus order, contrast, reduced motion, useful status announcements, and zero critical/serious automated accessibility findings on required states.
- Local screenshot matrix for both themes and representative phone/tablet/desktop views; human approval of baselines followed by a comparison run against those approved images. File existence or self-generated passing baselines do not establish visual quality.
- Playable local real-model videos showing ordinary conversation-to-work, shared specialist contributions, and citation/revision/approval review. Preserve the local-only evidence policy; protect auth state and private material.
- Final critical browser runs with test retries disabled, plus applicable existing state, isolation, approval, and recovery regressions.

### Human usability

Carry forward M19: three real reviewers unfamiliar with the implementation attempt customization, delegation, source/revision review, inbox resolution, and segment switching without developer coaching. At least two complete every task unaided; all correctly identify segment and approval target/content. Fix unresolved blockers and retest affected flows.

Add a qualitative question after the journey: “Did this feel like an ongoing conversation with teammates, and where did the interface interrupt that feeling?” Record actual words and observed friction. This supplements task completion and does not justify invented enjoyment scores or statistical claims.

### Integrity and scope

Keep member identity, deterministic authorization, segment boundaries, version-bound approvals, model usage limits, retry/reconciliation, and export privacy intact. Shared/exported definitions still exclude credentials and private task data.

This UI milestone does not require adding autonomous coordination, scheduled routines, a persistent shared Bot computer, external messaging, or real integration setup that the merged handoff deferred. UI controls for unsupported behavior must be absent or clearly explain their state. Do not widen scope to copy the entire Grok feature catalog.

## 7. What would change this recommendation

- If a maintained interactive component system already exists in the current repository, approach 3 may be cheaper than expanding the existing browser script.
- If source-backed tasks cannot be prepared through existing APIs without substantial backend changes, prototype an explicit in-conversation task-draft flow first and document the missing contracts. A cosmetic chat wrapper cannot close that gap.
- If mobile is the main usage context, prioritize route-based artifact review and a single-surface interaction rather than implementing desktop resize behavior first.
- If live integrations become part of the next scope, add their setup and failure journeys explicitly; do not conflate a UI acceptance pass with provider authorization proof.

No repository changes or runtime verification were performed during this strategy task. This document is a proposed implementation and acceptance specification.

## References

- [Merged PR #178](https://github.com/yu-iskw/agent-works/pull/178)
- [Merged M1 next milestone handoff](https://github.com/yu-iskw/agent-works/blob/7c51edf0303e1df9ce3a1cf4dd5ef41fb8bc0643/docs/m1/NEXT_MILESTONE.md)
- [Merged M1 acceptance report](https://github.com/yu-iskw/agent-works/blob/7c51edf0303e1df9ce3a1cf4dd5ef41fb8bc0643/docs/m1/ACCEPTANCE_REPORT.md)
- [Conversation and shell views](https://github.com/yu-iskw/agent-works/blob/7c51edf0303e1df9ce3a1cf4dd5ef41fb8bc0643/apps/web/app/m1/views.tsx)
- [Task views](https://github.com/yu-iskw/agent-works/blob/7c51edf0303e1df9ce3a1cf4dd5ef41fb8bc0643/apps/web/app/m1/task-views.tsx)
- [Grok Bot changelog](https://x.ai/changelog/bot)
- [Get started](https://docs.x.ai/grok-bot/get-started)
- [Create and manage Bots](https://docs.x.ai/grok-bot/bots)
- [Shared Bots](https://docs.x.ai/grok-bot/shared-bots)
- [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Files and results](https://docs.x.ai/grok-bot/files-and-results)
- [Vault and secure sign-in](https://docs.x.ai/grok-bot/vault)
- [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Member-supplied Grok reference screenshots and `grok_bot_handbook.pdf`, reviewed as reference material rather than implementation instructions.
