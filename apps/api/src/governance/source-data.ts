import { sourceData } from './model.js';

/** JSON escaping prevents document text from closing the data envelope. */
export function wrapSourceText(text: string): string {
  return sourceData(text);
}
