// Everything an MCP server tells us (names, descriptions, schemas, instructions) is untrusted data.
// These helpers make it inert: control and invisible characters are shown as [U+XXXX], and size is bounded.
// They run before a value is stored or returned. The metadata hash is computed on the raw value, before this.

// Zero-width, bidi controls, soft hyphen, filler characters, variation selectors (except the emoji ones FE0E/FE0F),
// Braille blank, byte-order mark, line/paragraph separators, musical formatting characters, lone surrogates and the
// Unicode tag block.
export const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯⠀ㅤ︀-︍﻿ﾠ￹-￻\u2028\u2029\u{1D173}-\u{1D17A}\uD800-\uDFFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNSAFE_G = new RegExp(`${INVISIBLE.source}|${CONTROL.source}`, 'gu');

export const hasInvisible = (s) => INVISIBLE.test(String(s));

export function revealText(value, max = 2000) {
  const s = String(value ?? '').replace(UNSAFE_G, (ch) => `[U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Deep copy with every string revealed and bounded; depth, array and key counts capped. Never executes anything.
export function inertValue(value, depth = 0) {
  if (typeof value === 'string') return revealText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => inertValue(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [revealText(k, 128), inertValue(v, depth + 1)]));
  }
  return undefined;
}
