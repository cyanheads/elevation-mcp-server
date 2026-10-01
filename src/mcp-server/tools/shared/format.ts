/**
 * @fileoverview Markdown helpers for `format()` and notices: neutralizing
 * upstream-authored text placed in an inline slot (a table cell, a heading, a
 * list item), and count wording that agrees in number.
 * @module mcp-server/tools/shared/format
 */

/** Line-break characters; each becomes one space once a CRLF pair is folded to LF. */
const LINE_BREAKS = new Set([0x0a, 0x0d, 0x85, 0x2028, 0x2029]);

/** Markdown/HTML/table syntax characters, backslash-escaped. `\` is escaped too, so `\|` cannot cancel a pipe escape. */
const ESCAPED = new Set(['\\', '[', ']', '<', '>', '|']);

/** C0/C1 controls and the bidi controls U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. */
function isStripped(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** `1 sample` / `3 samples`. */
export const countOf = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

/** The word form (verb, pronoun) agreeing with `count`. */
export const agree = (count: number, singular: string, plural: string) =>
  count === 1 ? singular : plural;

/** A signed figure for display: `+12.3`, `-4`, `0`. */
export const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/**
 * Makes upstream-authored text safe for an inline markdown slot: each line
 * break (a CRLF pair, a lone CR or LF, NEL, U+2028, U+2029) becomes one space,
 * control and bidi characters are stripped, and `\ [ ] < > |` are
 * backslash-escaped so link, image, HTML, and table syntax stay inert.
 * `structuredContent` keeps the original value.
 */
export function inlineText(value: string): string {
  let out = '';
  for (const char of value.replaceAll('\r\n', '\n')) {
    const code = char.codePointAt(0) ?? 0;
    if (LINE_BREAKS.has(code)) out += ' ';
    else if (!isStripped(code)) out += ESCAPED.has(char) ? `\\${char}` : char;
  }
  return out;
}
