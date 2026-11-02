const SEGMENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOCAL_PATH = /^\/(?![/\\])[\w\-./~%?=&]*$/;

/**
 * The startup URL for a segment, or the site root when the id is not a plain segment id. Values
 * read back from the page are data, so they never reach navigation unchecked.
 */
export function segmentHome(segment: string): string {
  return SEGMENT_ID.test(segment) ? `/s/${encodeURIComponent(segment)}` : '/';
}

/** A same-origin path, or the site root for anything with a scheme, host or odd characters. */
export function localPath(value: string | null | undefined): string {
  return typeof value === 'string' && LOCAL_PATH.test(value) ? value : '/';
}
