# Agent Works UI reference pack

Ten generated implementation references: **eight desktop and two mobile**, equally divided between light and dark. Balanced information density, English controls, Japanese sample conversations, and research/metrics/engineering scenarios.

These are design concepts generated with the built-in `image_gen` tool. They are not screenshots of implemented Agent Works functionality and do not constitute runtime, accessibility, model, or integration acceptance evidence.

## Give this folder to Claude Code

1. Read `IMPLEMENTATION_PROMPT.md` for the complete implementation and acceptance contract.
2. Read `UI_UX_SPECIFICATION.md` for the agreed UI structure and reasoning.
3. Read the screen map and implementation notes below, then visually inspect all ten PNGs.
4. Use `index.html` to browse and open the original images. `generation-prompts.json` preserves the generation prompt set and corrective edits.
5. Implement actual components and behavior. Do not use these full-screen PNGs as the application UI, fake successful tool calls, or treat mockup content as actual source data.

If written requirements and image details differ, the implementation prompt and confirmed design decisions govern behavior. Images establish composition, hierarchy, spacing, conversation rhythm, and the appearance of cards/panels. Real implementation still needs the required E2E, screenshot, video, and human review gates.

## Screen map

The PNGs are not committed. They live in the gitignored `artifacts/ui/reference/` folder of a local checkout.

| Image                                                                        | Theme/device               | Demonstrates                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 01 — Conversation (`01-desktop-conversation-dark.png`)                       | Dark desktop, 1536 × 1024  | Teammate roster, short Japanese exchanges, inline task draft, context chips, panel closed.                           |
| 02 — Plan review (`02-desktop-plan-review-light.png`)                        | Light desktop, 1536 × 1024 | Review a coordinator plan alongside the conversation; specialists, sources, boundary, approve/reject.                |
| 03 — Shared work (`03-desktop-shared-work-dark.png`)                         | Dark desktop, 1536 × 1024  | Work sidebar, named specialist contributions, real-stage work card, collapsed handoffs, new activity.                |
| 04 — Result and sources (`04-desktop-result-sources-light.png`)              | Light desktop, 1536 × 1024 | Results sidebar, resizable artifact panel, citation passage, revision context, preserved draft.                      |
| 05 — Metrics (`05-desktop-metrics-dark-v2.png`)                              | Dark desktop, 1536 × 1024  | Numerical comparison and chart, findings versus hypotheses, source provenance.                                       |
| 06 — Engineering revisions (`06-desktop-engineering-revisions-light-v2.png`) | Light desktop, 1536 × 1024 | Proposed changes, revision comparison, planned tests, explicit no-code-changed state.                                |
| 07 — Attention and approval (`07-desktop-attention-approval-dark.png`)       | Dark desktop, 1536 × 1024  | Bounded decision inbox and exact action review, with demo destination and pending status.                            |
| 08 — Personalization (`08-desktop-teammate-preferences-light.png`)           | Light desktop, 1536 × 1024 | Avatar/name/accent/role controls, reusable skill, appearance and startup preferences.                                |
| 09 — Mobile conversation (`09-mobile-conversation-dark.png`)                 | Dark mobile, 862 × 1824    | Single conversation surface, plan card, mention picker, selected context, touch-sized controls.                      |
| 10 — Mobile approval (`10-mobile-result-approval-light-v2.png`)              | Light mobile, 941 × 1672   | Full-width review, visible account/destination/revision, demo label, fixed decision actions, return to conversation. |

Use numbered final filenames, including the `-v2` revisions. Discarded drafts are not part of this pack.

## Shared visual direction

- A quiet neutral workspace with mint as the principal action accent. Use restrained identity colors: Haru/mint, Mika/amber, Ren/lavender, Kai/blue. Make semantic status colors and segment identity distinguishable.
- A familiar left roster/navigation region, central conversation, and contextual right panel. Desktop screenshots are reference canvases; use responsive constraints rather than hardcoded screenshot dimensions.
- Sidebar tabs are Teammates, Work, Results. New and Inbox remain easy to access in every relevant desktop state. Keep list rendering/search/pagination bounded.
- Short exchanges remain bubbles. Task, result, question, plan, approval, and failure content use compact interactive cards. The full artifact and evidence live in the panel.
- Preserve balanced spacing and readable Japanese text. Use a font stack with appropriate Japanese coverage; a Latin font paired with Noto Sans JP or a suitable system Japanese font is a reasonable implementation choice.
- Mobile shows one working surface at a time. Going back restores the conversation and draft. The image pixel dimensions are not CSS viewport dimensions.

## Interaction requirements that a still image cannot show

- Sidebar tabs remember position; switching them does not discard the current conversation or draft.
- Context chips affect real model/task input. Mention/command menus work by keyboard and touch; unsupported actions are not decorative promises.
- Panel resize works by pointer and keyboard, clamps to the viewport, and supports expand/restore/close. Citations and revisions preserve source and reading context.
- Shared timelines show actual messages/contributions. Working, unread, and needs-attention have distinct meanings; reading is not approving.
- Approval binds the exact reviewed destination, account, content, and revision. Plan acceptance is distinct from publishing an artifact.
- Themes and startup preferences persist per member. Drafts, context, cached content, and delayed responses are member/segment scoped.
- Local acceptance must use real configured Gemini, while the identity/source simulation scope remains explicit. A Gemini label in an illustration proves no real model call occurred.

## Normalize these illustrative details during implementation

AI-generated references have minor incidental differences. Apply one shared component/token system rather than treating every variation as a new requirement:

1. Some screens use different New/Inbox placements or button fills. Normalize those controls across the actual app; screen 01's missing standalone navigation controls are not permission to omit them.
2. Lock avatar identity and color across headers, mentions, sidebar, and cards. A small header avatar inconsistency in a mockup must not change Kai from blue to another teammate's identity.
3. English is the control/interface language in this pack. Japanese belongs to conversations, task descriptions, artifact/source content, and user-editable values. Translate incidental Japanese helper copy in the mockups to English in the default interface.
4. Appearance and startup choice are member-level workspace preferences, even though screen 08 shows them adjacent to teammate settings. Make the scope clear and do not save them separately for each Bot.
5. Display names, account email, vendor labels, dates, repository paths, and source excerpts are fictional examples. Do not hardcode them or infer business facts. Replace them with authorized records. Date differences among illustrations are not freshness rules.
6. The metrics fixture example is September 4.8%, October 4.1%, a decrease of 0.7 percentage points. Use verified calculations and actual chart data; screen 05's corrected version is the selected reference.
7. Screen 06 is a proposal. Planned tests are not passed tests; no repository mutation is implied. File names in the diff are illustrative.
8. Screen 08's saved-skill card is an example state. Show it only after an actual supported save/attachment action succeeds; do not invent a conversational save capability that does not exist.
9. Decorative stars, presence dots, and message ticks are not requirements for provider branding, online presence tracking, or read receipts. Show only statuses the backend actually knows.
10. Keep the required exact-approval scope visible even if content is long. Never hide account, destination, or revision solely in collapsed details. Screen 10's corrected version demonstrates this.

The written implementation acceptance criteria remain mandatory, including testing approximately 375, 768, and 1440 CSS pixel widths. Generated images do not certify contrast, accessibility, responsiveness, or usable touch targets.

## Copyable Claude Code handoff

> Implement Agent Works using IMPLEMENTATION_PROMPT.md and UI_UX_SPECIFICATION.md in this folder. Visually inspect the ten numbered PNGs using the screen map in README.md. Match the shared conversation-centered layout, balanced density, light/dark themes, contextual review panel, and compact cards. Use the images as design references and the written requirements as the behavioral contract. Resolve the listed illustrative inconsistencies with one consistent component system. Keep working through implementation, real-Gemini local Compose testing, visual inspection, repair, and all acceptance gates. Do not replace the UI with screenshots or treat these generated mockups as evidence that the application already works.

## Generation provenance

Tool: built-in `image_gen`; no CLI fallback. Screen 01 established the visual anchor. Subsequent screens edited that anchor or its light-theme result variant to preserve styling. Final selected versions include targeted corrections to the metrics label, planned-test status, and mobile approval scope. The complete prompt set and correction prompts are in `generation-prompts.json`.
