import { describe, expect, it } from 'vitest';

import { parseBlocks, parseInline, safeHref } from './markdown-parse.js';
import { renderMarkdown } from './markdown.js';

import type { ComponentChild, VNode } from 'preact';

const isVNode = (node: ComponentChild): node is VNode =>
  typeof node === 'object' && node !== null && 'type' in node;

/** Serialises the node tree the renderer built; strings are shown escaped as the DOM would. */
function html(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number')
    return String(node).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (Array.isArray(node)) return node.map(html).join('');
  if (!isVNode(node) || typeof node.type !== 'string') return '';
  const { children, ...rest } = node.props as Record<string, unknown>;
  const attrs = Object.entries(rest)
    .filter(([name, value]) => name !== 'key' && value !== null && value !== undefined)
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join('');
  return `<${node.type}${attrs}>${html(children as ComponentChild)}</${node.type}>`;
}

const render = (text: string): string => html(renderMarkdown(text));

describe('markdown blocks', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(render('one\ntwo\n\nthree')).toBe(
      '<div class="md"><p>one<br></br>two</p><p>three</p></div>',
    );
  });

  it('renders headings as strong text, never as heading elements', () => {
    expect(render('## Findings')).toBe(
      '<div class="md"><p class="md-heading"><strong>Findings</strong></p></div>',
    );
  });

  it('renders ordered and unordered lists with continuation lines joined', () => {
    expect(parseBlocks('- a\n  more\n- b\n\n1. x\n2) y')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'a more' }], [{ kind: 'text', text: 'b' }]],
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'x' }], [{ kind: 'text', text: 'y' }]],
      },
    ]);
    expect(render('* a\n* b')).toBe('<div class="md"><ul><li>a</li><li>b</li></ul></div>');
  });

  it('keeps fenced code verbatim, markup included', () => {
    expect(render('```\n<b>x</b> **not bold**\n```')).toBe(
      '<div class="md"><pre><code>&lt;b&gt;x&lt;/b&gt; **not bold**</code></pre></div>',
    );
  });
});

describe('markdown inline', () => {
  it('parses bold, italic and code', () => {
    expect(parseInline('a **b** *c* _d_ `e`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'e' },
    ]);
  });

  it('leaves intra-word underscores and lone stars literal', () => {
    expect(parseInline('snake_case_name 2 * 3')).toEqual([
      { kind: 'text', text: 'snake_case_name 2 * 3' },
    ]);
  });

  it('links http(s) with noopener and a visible URL', () => {
    expect(render('see [docs](https://example.test/a?b=1)')).toBe(
      '<div class="md"><p>see <a href="https://example.test/a?b=1" rel="noopener noreferrer" target="_blank" class="md-link">docs<span class="md-href"> (https://example.test/a?b=1)</span></a></p></div>',
    );
    expect(render('go to https://example.test/x.')).toBe(
      '<div class="md"><p>go to <a href="https://example.test/x" rel="noopener noreferrer" target="_blank" class="md-link">https://example.test/x</a>.</p></div>',
    );
  });

  it('only accepts http and https hrefs', () => {
    expect(safeHref('https://a.test/')).toBe('https://a.test/');
    expect(safeHref('HTTP://a.test')).toBe('http://a.test/');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,hi')).toBeUndefined();
    expect(safeHref('//a.test')).toBeUndefined();
    expect(safeHref('/relative')).toBeUndefined();
  });
});

describe('markdown refuses to render markup', () => {
  it.each([
    ['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['<img src=x onerror=alert(1)>', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'],
    ['[x](javascript:alert(1))', '<p>[x](javascript:alert(1))</p>'],
    ['[x](data:text/html;base64,AAAA)', '<p>[x](data:text/html;base64,AAAA)</p>'],
    ['![alt](https://a.test/x.png)', '<p>![alt](https://a.test/x.png)</p>'],
    ['&lt;b&gt;&amp;', '<p>&amp;lt;b&amp;gt;&amp;amp;</p>'],
    ['**<b>bold</b>**', '<p><strong>&lt;b&gt;bold&lt;/b&gt;</strong></p>'],
    ['`<svg onload=alert(1)>`', '<p><code>&lt;svg onload=alert(1)&gt;</code></p>'],
    [
      '<a href="https://a.test">x</a>',
      '<p>&lt;a href="<a href="https://a.test/" rel="noopener noreferrer" target="_blank" class="md-link">https://a.test<span class="md-href"> (https://a.test/)</span></a>"&gt;x&lt;/a&gt;</p>',
    ],
  ])('%s renders as text', (input, expected) => {
    expect(render(input)).toBe(`<div class="md">${expected}</div>`);
  });

  it('never emits an element the grammar does not name', () => {
    const tree = renderMarkdown('<iframe></iframe>\n\n# <style>x</style>\n\n- <marquee>');
    const tags = new Set<string>();
    const walk = (node: ComponentChild): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (isVNode(node) && typeof node.type === 'string') {
        tags.add(node.type);
        walk((node.props as { children?: ComponentChild }).children);
      }
    };
    walk(tree);
    expect([...tags].sort()).toEqual(['div', 'li', 'p', 'strong', 'ul']);
  });
});
