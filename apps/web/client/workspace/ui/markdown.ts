// Markdown to Preact nodes. Never innerHTML: every string reaches the DOM as a text node, so the
// only elements that can appear are the ones this file creates.

import { h } from 'preact';

import { parseBlocks } from './markdown-parse.js';

import type { Block, Inline } from './markdown-parse.js';
import type { ComponentChild, JSX } from 'preact';

function inline(node: Inline, key: number): ComponentChild {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'code':
      return h('code', { key }, node.text);
    case 'strong':
      return h('strong', { key }, inlines(node.children));
    case 'em':
      return h('em', { key }, inlines(node.children));
    case 'link':
      return h(
        'a',
        { key, href: node.href, rel: 'noopener noreferrer', target: '_blank', class: 'md-link' },
        node.text,
        node.text === node.href ? null : h('span', { class: 'md-href' }, ` (${node.href})`),
      );
  }
}

const inlines = (nodes: readonly Inline[]): ComponentChild[] => nodes.map(inline);

function lines(rows: readonly (readonly Inline[])[]): ComponentChild[] {
  return rows.flatMap((row, i) =>
    i === 0 ? inlines(row) : [h('br', { key: `br${i}` }), ...inlines(row)],
  );
}

function block(node: Block, key: number): JSX.Element {
  switch (node.kind) {
    case 'paragraph':
      return h('p', { key }, lines(node.lines));
    case 'heading':
      return h('p', { key, class: 'md-heading' }, h('strong', null, inlines(node.inlines)));
    case 'code':
      return h('pre', { key }, h('code', null, node.text));
    case 'list':
      return h(
        node.ordered ? 'ol' : 'ul',
        { key },
        node.items.map((item, i) => h('li', { key: i }, inlines(item))),
      );
  }
}

export function renderMarkdown(text: string): JSX.Element {
  return h('div', { class: 'md' }, parseBlocks(text).map(block));
}

export function Markdown(props: { readonly text: string }): JSX.Element {
  return renderMarkdown(props.text);
}
