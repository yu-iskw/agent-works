// Panel state that is not selection: whether the panel has taken the content area, and the
// reading position of each panel view so a citation detour or a poll never loses the place.

export type ReviewState = {
  readonly expanded: boolean;
  readonly positions: Readonly<Record<string, number>>;
};

export const INITIAL_REVIEW: ReviewState = { expanded: false, positions: {} };

/** The panel has taken the content area: open and expanded. */
export const panelExpanded = (state: {
  readonly route: { readonly panel: { readonly kind: string } };
  readonly review: ReviewState;
}): boolean => state.route.panel.kind !== 'none' && state.review.expanded;

export function reviewExpand(review: ReviewState, expanded: boolean): ReviewState {
  return review.expanded === expanded ? review : { ...review, expanded };
}

export function reviewPosition(review: ReviewState, key: string, top: number): ReviewState {
  // Keys are panel position keys built from segment ids, read from a plain record.
  // eslint-disable-next-line security/detect-object-injection
  if (review.positions[key] === top) return review;
  return { ...review, positions: { ...review.positions, [key]: top } };
}
