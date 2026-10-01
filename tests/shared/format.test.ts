/**
 * @fileoverview Tests for inlineText: upstream text in an inline markdown slot.
 * Invisible characters are built from code points so the source stays readable.
 * @module tests/shared/format.test
 */

import { describe, expect, it } from 'vitest';
import { inlineText } from '@/mcp-server/tools/shared/format.js';

/** The character at `code`, for invisible characters. */
const cp = (code: number) => String.fromCodePoint(code);

const NEL = cp(0x85);
const LINE_SEPARATOR = cp(0x2028);
const PARAGRAPH_SEPARATOR = cp(0x2029);

/** Counts occurrences of `chars` not preceded by an odd run of backslashes (i.e. live markdown syntax). */
function liveSyntaxCount(text: string, chars: string): number {
  let live = 0;
  let backslashes = 0;
  for (const char of text) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (chars.includes(char) && backslashes % 2 === 0) live++;
    backslashes = 0;
  }
  return live;
}

const hasLineBreak = (text: string) =>
  [...text].some((char) => ['\n', '\r', NEL, LINE_SEPARATOR, PARAGRAPH_SEPARATOR].includes(char));

describe('inlineText', () => {
  it('passes ordinary text through', () => {
    expect(inlineText('6/5/2021')).toBe('6/5/2021');
    expect(inlineText('0/5/2013')).toBe('0/5/2013');
    expect(inlineText('')).toBe('');
  });

  it('keeps printable non-ASCII and astral characters', () => {
    expect(inlineText('Österreich © 2017 – 📍 日本')).toBe('Österreich © 2017 – 📍 日本');
  });

  describe('line breaks', () => {
    it.each([
      ['LF', 'a\nb', 'a b'],
      ['CR', 'a\rb', 'a b'],
      ['CRLF (one break, one space)', 'a\r\nb', 'a b'],
      ['NEL U+0085', `a${NEL}b`, 'a b'],
      ['LS U+2028', `a${LINE_SEPARATOR}b`, 'a b'],
      ['PS U+2029', `a${PARAGRAPH_SEPARATOR}b`, 'a b'],
      ['a run of breaks', 'a\n\n\nb', 'a   b'],
    ])('flattens %s to spaces', (_name, input, expected) => {
      expect(inlineText(input)).toBe(expected);
    });

    it('leaves no line break in what an upstream could send', () => {
      const hostile = '6/5/2021\r\n| injected | row |\r\n# Heading\n\n```\ncode\n```';
      expect(hasLineBreak(inlineText(hostile))).toBe(false);
    });
  });

  describe('control and bidi characters', () => {
    it.each([
      ['NUL', 0x00],
      ['tab', 0x09],
      ['U+001F', 0x1f],
      ['DEL', 0x7f],
      ['U+0080', 0x80],
      ['U+009F', 0x9f],
      ['U+061C', 0x061c],
      ['U+200E', 0x200e],
      ['U+200F', 0x200f],
      ['U+202A', 0x202a],
      ['U+202D', 0x202d],
      ['U+202E (right-to-left override)', 0x202e],
      ['U+2066', 0x2066],
      ['U+2069', 0x2069],
    ])('strips %s', (_name, code) => {
      expect(inlineText(`a${cp(code)}b`)).toBe('ab');
    });

    it.each([
      ['space', 0x20],
      ['no-break space', 0xa0],
      ['zero-width joiner', 0x200d],
      ['narrow no-break space', 0x202f],
      ['U+206A', 0x206a],
    ])('keeps %s, just outside the stripped ranges', (_name, code) => {
      expect(inlineText(`a${cp(code)}b`)).toBe(`a${cp(code)}b`);
    });
  });

  describe('markdown, HTML, and table syntax', () => {
    it.each([
      ['a backslash', 'a\\b', 'a\\\\b'],
      ['an opening bracket', 'a[b', 'a\\[b'],
      ['a closing bracket', 'a]b', 'a\\]b'],
      ['an opening angle bracket', 'a<b', 'a\\<b'],
      ['a closing angle bracket', 'a>b', 'a\\>b'],
      ['a pipe', 'a|b', 'a\\|b'],
    ])('escapes %s', (_name, input, expected) => {
      expect(inlineText(input)).toBe(expected);
    });

    it('defuses link, image, HTML, and table syntax', () => {
      const out = inlineText(
        '[click](https://evil.test) ![x](https://evil.test/p.png) <script>x</script> | a | b |',
      );
      expect(liveSyntaxCount(out, '[]<>|')).toBe(0);
      expect(out).toBe(
        '\\[click\\](https://evil.test) !\\[x\\](https://evil.test/p.png) \\<script\\>x\\</script\\> \\| a \\| b \\|',
      );
    });

    it('escapes the backslash too, so a pre-escaped pipe cannot cancel the escape', () => {
      expect(inlineText('a\\|b')).toBe('a\\\\\\|b');
      expect(liveSyntaxCount(inlineText('a\\|b'), '|')).toBe(0);
    });

    it.each([
      '\\\\[x]',
      '\\\\\\|',
      '|[<>]|\\',
      'a\r\n|---|---|\r\n| x | y |',
      '<img src=x onerror=alert(1)>',
      `${cp(0x202e)}|]\\`,
    ])('leaves no live syntax or line break in %j', (hostile) => {
      const out = inlineText(hostile);
      expect(liveSyntaxCount(out, '[]<>|')).toBe(0);
      expect(hasLineBreak(out)).toBe(false);
    });
  });
});
