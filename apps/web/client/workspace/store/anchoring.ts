const FOLLOW_THRESHOLD_PX = 48;

export type ScrollBox = {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
};

export const nearBottom = (box: ScrollBox, threshold = FOLLOW_THRESHOLD_PX): boolean =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;

/**
 * The scrollTop to apply after the list changed height. Following pins to the bottom; otherwise
 * the content the member was reading keeps its offset, which only moves when height was added
 * above it.
 */
export function scrollTopAfter(input: {
  readonly before: ScrollBox;
  readonly afterHeight: number;
  readonly follow: boolean;
  readonly addedAbove: number;
}): number {
  const { before, afterHeight, follow, addedAbove } = input;
  if (follow) return Math.max(0, afterHeight - before.clientHeight);
  return Math.max(0, before.scrollTop + addedAbove);
}
