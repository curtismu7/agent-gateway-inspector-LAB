import React from "react";
import { reveal } from "../lib/reveal.js";

// Everything an agent or an upstream sends is untrusted. It is only ever rendered as React text nodes (never innerHTML),
// so markup in a payload is shown, not run. Hidden characters become visible [U+XXXX] chips. Suspicious spans get a
// <mark>, which carries a title and the text itself, not colour alone.
const HOT = /<\/?IMPORTANT>|(?:ignore|disregard|forget) (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions?|rules?|prompts?)[^."]*|do not tell the user|~\/\.ssh\/\S*|https?:\/\/[^\s"',<]+|[\w.+-]+@[\w.-]+\.[a-z]+/gi;
const CHIP = /(\[U\+[0-9A-F]{4,6}\])/;

export function segments(text) {
  const s = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(HOT)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), hot: false });
    out.push({ text: m[0], hot: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), hot: false });
  return out;
}

const chips = (text) =>
  text.split(CHIP).map((p, i) =>
    i % 2 ? <span key={i} className="chip" title="Hidden character, shown instead of hidden">{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>);

export function Untrusted({ text, block = false, plain = false }) {
  const Tag = block ? "pre" : "span";
  const shown = reveal(text);
  return (
    <Tag className={`untrusted${block ? " untrusted--block" : ""}`} data-testid="untrusted">
      {plain
        ? chips(shown)
        : segments(shown).map((p, i) => (p.hot ? <mark key={i} title="Flagged: instruction-like text, path or address">{chips(p.text)}</mark> : <React.Fragment key={i}>{chips(p.text)}</React.Fragment>))}
    </Tag>
  );
}

export const pretty = (value) => JSON.stringify(value, null, 2);
