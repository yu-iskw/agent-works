export type Html = { readonly kind: 'html'; readonly html: string };

export type Child = string | number | boolean | null | undefined | Html | readonly Child[];

export type ElementProps = Readonly<Record<string, string | number | boolean | undefined>>;

type ComponentProps = {
  readonly [key: string]: string | number | boolean | undefined | readonly Child[];
  readonly children?: readonly Child[];
};

type Component = (props: ComponentProps) => Html;

const voidTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

export function h(
  tag: string | Component,
  props: ElementProps | null,
  ...children: readonly Child[]
): Html {
  if (typeof tag === 'function') return tag({ ...(props ?? {}), children });
  const attrs = renderAttrs(props);
  if (voidTags.has(tag)) return mark(`<${tag}${attrs}>`);
  return mark(`<${tag}${attrs}>${renderChildren(children)}</${tag}>`);
}

export function Fragment(
  props: { readonly children?: readonly Child[] } | null,
  ...children: readonly Child[]
): Html {
  return mark(renderChildren([...(props?.children ?? []), ...children]));
}

export function renderDocument(root: Html): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ask</title></head><body>${root.html}</body></html>`;
}

function mark(html: string): Html {
  return { kind: 'html', html };
}

function renderAttrs(props: ElementProps | null): string {
  if (props === null) return '';
  let attrs = '';
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false || name === 'children' || name === 'key') continue;
    attrs += value === true ? ` ${name}` : ` ${name}="${escapeAttr(String(value))}"`;
  }
  return attrs;
}

function renderChildren(children: readonly Child[]): string {
  let html = '';
  for (const child of children) html += renderChild(child);
  return html;
}

function renderChild(child: Child): string {
  if (child === null || child === undefined || typeof child === 'boolean') return '';
  if (typeof child === 'string') return escapeText(child);
  if (typeof child === 'number') return escapeText(String(child));
  if (isHtml(child)) return child.html;
  return renderChildren(child);
}

function isHtml(value: Child): value is Html {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace h {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = Html;
    interface IntrinsicElements {
      [tag: string]: ElementProps;
    }
  }
}
