---
name: web-screen-layout
description: >-
  Sets the page frame, prose width, settings rows, and dialog scrolling for
  agent-works screens. Use when adding or changing a screen under
  apps/web/client, choosing a width, composing a settings row, or laying out a
  dialog. Do not use for server HTML in apps/web/app, for where data comes
  from, or for the Ask question and its citations.
---

# Web screen layout

## Purpose

A configuration screen uses one page frame, the prose width, and one row variant. PageShell, PageRows, and Item do not exist yet. The first configuration screen creates them under `apps/web/client/components`. Until those three exist, no screen draws its own bordered card or a second container width.

Ask is the only screen today. It is a question, an answer, and citations. It is not a settings card.

## The shape

PageShell is the page. The header carries the title, a short description, and one primary verb. A return link sits above the header when the screen was opened from a list. The return link is not the primary verb.

The body is a prose column. The default width is `max-w-2xl`. A table that must be scanned may use `max-w-5xl`. Every other screen stays on the prose width.

PageRows is one grouped card. Item is one row in that card. Put a divider between rows, and no divider after the last. A gap between rows makes a stack of cards.

Keep the document root font size at 15px. A rem-based Tailwind width is then 0.9375 times the pixel value in the Tailwind docs.

| Token       | Documented | At 15px |
| ----------- | ---------- | ------- |
| `max-w-2xl` | 672px      | 630px   |
| `max-w-3xl` | 768px      | 720px   |
| `max-w-5xl` | 1024px     | 960px   |

Measure the element. Do not hard-code 672, 768, or 1024.

## Procedures

### 1. Lay out a screen

1. Open with PageShell. Pass the title and the description. Leave the width at `max-w-2xl` unless the screen is a table that must be scanned. That table may use `max-w-5xl`.
2. Put the one primary verb in the header.
3. Put the return link above the header when a list opened this screen.
4. Group the decisions into sections. Give each section one PageRows card.
5. Put each decision in an Item. Divide the rows. Do not leave a divider after the last row.

### 2. Compose a row

1. Lead with one Tabler icon so the card scans as a list.
2. Put the title on the first line. Add a second line only when the row needs it.
3. Put one control or one value at the end of the row.
4. Put a set of chips or toggles on its own line under the title.
5. Write the second line in the present tense and state the consequence. "Ask can cite this source." is the shape.

### 3. Choose the row kind

Use one row variant for the whole screen. A filled row and a bordered row on the same screen read as two lists.

1. One immediate value uses a switch. It takes effect when switched. There is no save. The second line states the consequence in the present tense.
2. More than one value uses a summary of the current answer, a chevron, and a dialog. The summary is the answer, as in "2 of 3 sources." Derive it from the query so a save updates it. Editing several values in the row turns the screen into a form.
3. A read-only value sits at the end of the row. There is no chevron and nothing to click. A chevron means the row opens a dialog.

### 4. Lay out a dialog

1. Give the dialog a header, a body, and a footer.
2. Make the body a direct child of the dialog content. That body is the element that scrolls.
3. Do not wrap the header, the body, and the footer in one padded div. The wrap stops the body from scrolling.

## Decision tree

- Adding a configuration screen leads to procedure 1, then procedure 2 for each row.
- Adding a row leads to procedure 2, then procedure 3.
- A row that toggles one thing uses the switch in procedure 3.
- A row that edits more than one value uses the summary, the chevron, and procedure 4.
- A row that only states a value uses the read-only row in procedure 3.
- A width that needs pixels is measured on the element.
- Where the data comes from, and how pending, error, empty, and rows render, is [web-data-access](../web-data-access/SKILL.md).

## Red flags

| Signal                                           | Meaning                                            | What to do instead                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A bordered card written in the screen            | The screen drew its own container                  | Use PageRows. The first configuration screen creates PageShell, PageRows, and Item under `apps/web/client/components` and does not keep a private card |
| A new `max-w-*` on one screen                    | A second container width                           | Keep `max-w-2xl`, or `max-w-5xl` for a table                                                                                                           |
| A pixel constant of 672, 768, or 1024            | Those pixels assume a 16px root                    | Measure the element                                                                                                                                    |
| A switch on a row that edits two or more values  | Some values change in the row and some in a dialog | Use a summary, a chevron, and a dialog                                                                                                                 |
| A chevron on a row that opens nothing            | A destination that does not exist                  | Show the value and omit the chevron                                                                                                                    |
| Two row variants on one screen                   | The screen looks like two lists                    | Use one variant for every row                                                                                                                          |
| A save button beside a switch                    | The switch already took effect                     | Remove the save                                                                                                                                        |
| The return control in the header action          | The header action is the one primary verb          | Put the return link above the header                                                                                                                   |
| A spinner, a skeleton, or the word Loading       | A placeholder stands in for the answer             | Render nothing. Pending belongs to web-data-access                                                                                                     |
| A dialog body wrapped with its header and footer | The body will not scroll                           | Make the body a direct scrolling child                                                                                                                 |

## Error handling

The row summary stays stale after the dialog saves. The screen copied the summary into state. Derive it from the query on each render.

A card is clipped, or its center is visibly wrong. The screen used a pixel constant from the Tailwind docs. Measure the drawn element.

Dialog body text paints over the footer. The body is not the scrolling child. Make it a direct child of the dialog content and let that child scroll.

The dialog stops scrolling after a refactor. The body is no longer a direct child. Restore that relationship.

Two configuration screens that should match do not. One of them drew its own card. Delete that wrapper.

The screen cannot use this frame. Say so in the response. Do not invent another width.
