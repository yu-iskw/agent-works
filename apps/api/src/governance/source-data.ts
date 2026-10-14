import { sourceData } from '@agent-works/domain/data-governance';

/** JSON escaping prevents document text from closing the data envelope. */
export function wrapSourceText(text: string): string {
  return sourceData(text);
}
