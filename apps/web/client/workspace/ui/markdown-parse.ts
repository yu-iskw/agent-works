// A deliberately small Markdown grammar for teammate messages and artifact text. Everything the
// grammar does not name stays literal text, so HTML, entities, images and non-http links can only
// ever render as the characters the author typed.

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly text: string };

export type Block =
  | { readonly kind: 'paragraph'; readonly lines: readonly (readonly Inline[])[] }
  | { readonly kind: 'heading'; readonly inlines: readonly Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    };

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;

/** Only absolute http(s) URLs become links; the scheme check is on the parsed URL, not the text. */
export function safeHref(raw: string): string | undefined {
  const url = URL.parse(raw.trim());
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:')
    ? url.href
    : undefined;
}

// Alternatives, by group: 1-2 code span, 3 strong, 4 star em, 5 underscore em, 6-7 link, bare URL.
// A fresh global pattern per call, so nested parses never share lastIndex. Every alternative is
// lazy or a negated class, and inputs are messages of at most a few thousand characters.
const inlinePattern = (): RegExp =>
  // eslint-disable-next-line security/detect-unsafe-regex
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(\S(?:[\s\S]*?\S)?)\*\*|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])|(?<![\w_])_(\S(?:[^_\n]*?\S)?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)|https?:\/\/[^\s<>()]+/g;

const TRAILING = /[.,;:!?'"]+$/;

type Found = { readonly inline: Inline; readonly end: number };

function linkOf(text: string, href: string, whole: string, at: number, source: string): Inline {
  const safe = safeHref(href);
  // An image or a non-http link stays as the member sees it in the source text.
  const image = at > 0 && source[at - 1] === '!';
  return safe === undefined || image
    ? { kind: 'text', text: whole }
    : { kind: 'link', href: safe, text };
}

function inlineOf(m: RegExpExecArray, source: string): Found {
  const whole = m[0];
  const end = m.index + whole.length;
  const g: readonly (string | undefined)[] = m;
  if (g[2] !== undefined) return { inline: { kind: 'code', text: g[2].trim() }, end };
  if (g[3] !== undefined) return { inline: { kind: 'strong', children: parseInline(g[3]) }, end };
  const em = g[4] ?? g[5];
  if (em !== undefined) return { inline: { kind: 'em', children: parseInline(em) }, end };
  if (g[6] !== undefined && g[7] !== undefined)
    return { inline: linkOf(g[6], g[7], whole, m.index, source), end };
  const bare = whole.replace(TRAILING, '');
  const href = safeHref(bare);
  return href === undefined
    ? { inline: { kind: 'text', text: whole }, end }
    : { inline: { kind: 'link', href, text: bare }, end: m.index + bare.length };
}

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const last = out.at(-1);
  if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + text };
  else out.push({ kind: 'text', text });
}

export function parseInline(text: string): readonly Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  const re = inlinePattern();
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const { inline, end } = inlineOf(m, text);
    pushText(out, text.slice(cursor, m.index));
    if (inline.kind === 'text') pushText(out, inline.text);
    else out.push(inline);
    cursor = end;
    re.lastIndex = end;
  }
  pushText(out, text.slice(cursor));
  return out;
}

type Open =
  | { readonly kind: 'paragraph'; readonly lines: string[] }
  | { readonly kind: 'code'; readonly lines: string[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: string[] };

/** What a line outside a fence starts or continues. */
type Line =
  | { readonly kind: 'blank' }
  | { readonly kind: 'fence' }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'item'; readonly ordered: boolean; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

function classify(raw: string): Line {
  if (FENCE.test(raw)) return { kind: 'fence' };
  const line = raw.trim();
  if (line === '') return { kind: 'blank' };
  const heading = HEADING.exec(line);
  if (heading !== null) return { kind: 'heading', text: heading[1].trim() };
  const bullet = BULLET.exec(line);
  if (bullet !== null) return { kind: 'item', ordered: false, text: bullet[1] };
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) return { kind: 'item', ordered: true, text: numbered[1] };
  return { kind: 'text', text: line };
}

function closed(open: Open | undefined, out: Block[]): undefined {
  if (open === undefined) return undefined;
  if (open.kind === 'code') out.push({ kind: 'code', text: open.lines.join('\n') });
  else if (open.kind === 'list')
    out.push({ kind: 'list', ordered: open.ordered, items: open.items.map(parseInline) });
  else if (open.lines.length > 0)
    out.push({ kind: 'paragraph', lines: open.lines.map((line) => parseInline(line)) });
  return undefined;
}

/** Folds one classified line into the open block, returning the block that stays open. */
function fold(open: Open | undefined, line: Line, out: Block[]): Open | undefined {
  switch (line.kind) {
    case 'fence':
      closed(open, out);
      return { kind: 'code', lines: [] };
    case 'blank':
      return closed(open, out);
    case 'heading':
      closed(open, out);
      out.push({ kind: 'heading', inlines: parseInline(line.text) });
      return undefined;
    case 'item': {
      const list =
        open?.kind === 'list' && open.ordered === line.ordered
          ? open
          : (closed(open, out), { kind: 'list' as const, ordered: line.ordered, items: [] });
      list.items.push(line.text);
      return list;
    }
    case 'text': {
      if (open?.kind === 'list') {
        open.items[open.items.length - 1] += ` ${line.text}`;
        return open;
      }
      const paragraph =
        open?.kind === 'paragraph' ? open : { kind: 'paragraph' as const, lines: [] };
      paragraph.lines.push(line.text);
      return paragraph;
    }
  }
}

export function parseBlocks(text: string): readonly Block[] {
  const out: Block[] = [];
  let open: Open | undefined;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (open?.kind === 'code') {
      if (FENCE.test(raw)) open = closed(open, out);
      else open.lines.push(raw);
      continue;
    }
    open = fold(open, classify(raw), out);
  }
  closed(open, out);
  return out;
}
