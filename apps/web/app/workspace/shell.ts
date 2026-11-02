import { BOOTSTRAP_ID, MOUNT_ID } from '../../shared/contract.js';

import type { Bootstrap } from '../../shared/contract.js';

const escapeText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (value: string) => escapeText(value).replaceAll('"', '&quot;');

/** Every `<` becomes a JSON escape, so no text inside the JSON tag can close or open an element. */
function bootstrapJson(bootstrap: Bootstrap): string {
  return JSON.stringify(bootstrap).replaceAll('<', String.raw`\u003c`);
}

export function shellDocument(input: {
  readonly bootstrap: Bootstrap;
  readonly title: string;
  readonly summary: string;
}): string {
  const { bootstrap, title, summary } = input;
  const theme = bootstrap.prefs.theme === 'system' ? '' : ` data-theme="${bootstrap.prefs.theme}"`;
  return (
    `<!doctype html><html lang="en"${theme}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<title>${escapeText(title)} · Agent Works</title>` +
    `<link rel="stylesheet" href="/assets/workspace.css">` +
    `<script src="/assets/workspace.js" defer></script></head><body>` +
    `<script type="application/json" id="${BOOTSTRAP_ID}">${bootstrapJson(bootstrap)}</script>` +
    `<div id="${MOUNT_ID}"><p class="boot">${escapeText(summary)}</p>` +
    `<noscript><p><a href="${escapeAttr(bootstrap.fallbackHref)}">Open the page version of this conversation</a></p></noscript>` +
    `</div></body></html>`
  );
}
