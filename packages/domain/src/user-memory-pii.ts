/** Conservative local minimization, not a claim of complete PII detection. */
export function minimizeMemoryText(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/giu, '[email]')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '[government-id]')
      // eslint-disable-next-line security/detect-unsafe-regex -- account detector has a fixed 19-digit upper bound; intake caps text at 2048 characters
      .replace(/\b(?:\d[ -]?){13,19}\b/gu, '[account-number]')
      .replace(/\+?\d[\d ()-]{7,}\d/gu, '[phone]')
      .replace(/\b(?:password|secret|api[_ -]?key|token)\s*[:=]\s*\S+/giu, '[credential]')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim()
  );
}
