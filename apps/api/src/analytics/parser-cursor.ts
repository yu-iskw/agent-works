import { reject } from './errors.js';

import type { Token } from './lexer.js';
export class Cursor {
  private offset = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  peek(text: string): boolean {
    return this.tokens.at(this.offset)?.text.toUpperCase() === text;
  }
  take(): Token {
    const token = this.tokens.at(this.offset++);
    // eslint-disable-next-line security/detect-possible-timing-attacks -- token existence is public parser state
    if (token === undefined) reject('SQL_SYNTAX');
    return token;
  }
  consume(text: string): boolean {
    if (!this.peek(text)) return false;
    this.offset++;
    return true;
  }
  expect(text: string): void {
    if (!this.consume(text)) reject('SQL_SYNTAX');
  }
  identifier(): string {
    const token = this.take();
    if (
      token.kind !== 'word' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(token.text) ||
      ['constructor', 'prototype'].includes(token.text)
    )
      reject('SQL_IDENTIFIER');
    return token.text;
  }
  done(): boolean {
    return this.offset === this.tokens.length;
  }
}
