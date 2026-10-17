---
name: web-screen-layout
description: >-
  Sets the Ask shell, the shared Button, and the prose width for agent-works
  screens. The shell is a sidebar of questions, a header, a conversation, and
  a composer, with a mobile overlay below 768px. Use when adding or changing
  layout under apps/web/client, including the sidebar, the header, the
  conversation, the composer, or components/ui/button.tsx. Do not use for the
  thread reducer, for posting /api/ask, or for server HTML in apps/web/app.
---

# Web screen layout

## Purpose

The Ask screen is one shell. The regions are a sidebar of questions, a header, a conversation section, and a composer. Shared controls use the Button in `apps/web/client/components/ui/button.tsx`. Variant and size classes come from the lookup tables in that file.

PageShell, PageRows, Item, and dialogs are not in the tree. Do not add them to this shell.

Thread transitions, the per-attempt `requestId`, and the `/api/ask` body `{requestId, question}` are [web-data-access](../web-data-access/SKILL.md).

## The shape

`apps/web/client/app.tsx` owns the shell. The sidebar lists threads. The header carries the sidebar toggle, the title, and the theme toggle. The conversation is a `section` with the accessible name Conversation. The composer is the question form under that section.

The desktop query is `(min-width: 768px)`. At 768px and above, an open sidebar docks. Below 768px, an open sidebar is an overlay. A click on the backdrop closes the overlay. Escape closes the overlay.

The header title is Ask when no thread is active. Otherwise the title is the thread title. The thread title is the trimmed first question, or New question when that question is empty.

The conversation column and the composer use `max-w-2xl`. The document root font size is 15px in `apps/web/client/styles.css`. Measure a width on the element. Do not hard-code 672.

The Button lookup tables are `variantClass` and `sizeClass`.

| Lookup  | Keys                               |
| ------- | ---------------------------------- |
| variant | `primary`, `secondary`, `ghost`    |
| size    | `default`, `sm`, `icon`, `icon-sm` |

`round` is a separate boolean. True adds `rounded-full`. False adds `rounded-lg`. The defaults are variant `primary`, size `default`, and `round` false.

A thread with no turns is empty. The conversation then shows the heading Ask about your documents. A turn is pending, answered, or failed. Pending is a visible status line with `role=status` and the text Searching the documents. The pulse marks on that card are `aria-hidden`.

Thread history is in memory only and is lost on reload. The empty sidebar says questions appear here until you reload. Do not write threads to storage.

## Procedures

### 1. Lay out the shell

1. Keep the four regions in `apps/web/client/app.tsx`. The sidebar, the header, the conversation, and the composer stay in that order.
2. Choose docked or hidden at 768px and above. Choose overlay or hidden below 768px.
3. Close the overlay on backdrop click and on Escape.
4. Put the sidebar toggle, the title, and the theme toggle in the header.
5. Keep the conversation and the composer on `max-w-2xl`.

### 2. Use the shared Button

1. Import Button from `apps/web/client/components/ui/button.tsx`.
2. Pass a `variant` key and a `size` key from the lookup tables.
3. Add a new variant or size as a new key on the lookup table and a matching arm in the switch. The switch stays exhaustive.
4. Use `className` for spacing on one call site. A new visual kind belongs in the lookup table.
5. Leave PageShell, PageRows, Item, and any second button component uncreated.

### 3. Show the conversation

1. When the thread has no turns, show the empty heading Ask about your documents.
2. When a turn is pending, show the status line Searching the documents with `role=status`.
3. When a turn is answered, show the answer. Show the source list when `citations` is not empty. Keep the Copy answer button.
4. When a turn is failed, show the message with `role=alert` and the Try again button.
5. Leave the reducer transitions to web-data-access. This skill does not mint a `requestId`.

## Decision tree

- A change to the sidebar, the header, the conversation, or the composer leads to procedure 1.
- A new control leads to procedure 2.
- A change to empty, pending, answered, or failed markup leads to procedure 3, then web-data-access for the transition.
- A width that needs pixels is measured on the element.
- A `requestId`, a reducer action, or `POST /api/ask` belongs to web-data-access.

## Red flags

| Signal                                       | Meaning                                  | What to do instead                                                    |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| A second button component                    | Classes bypass the lookup tables         | Use Button. Add a key when the variant or size is new                 |
| PageShell, PageRows, Item, or a dialog       | A shared control that is not in the tree | Keep the four shell regions                                           |
| A docked sidebar below 768px                 | The narrow width has no overlay          | Use the overlay below 768px and close it on backdrop click and Escape |
| Pending with no status line                  | The wait has no accessible name          | Render Searching the documents with `role=status`                     |
| The word Loading, or an empty pending branch | The status line was replaced or removed  | Keep the status line. Leave the pulse marks `aria-hidden`             |
| A pixel constant of 672                      | That pixel value assumes a 16px root     | Measure the element. The root is 15px                                 |
| Threads written to storage                   | Reload would keep history                | Keep thread state in memory. A reload clears it                       |

## Error handling

The overlay covers the conversation and nothing dismisses it. Restore the backdrop click and the Escape handler.

The pending card is blank. Restore the status line with `role=status` and the text Searching the documents.

The header title stays Ask after a thread is active. Use the thread title. Use New question when the first question is empty.

Two call sites style Button with different one-off class strings for the same kind of control. Put that kind in `variantClass` or `sizeClass`.
