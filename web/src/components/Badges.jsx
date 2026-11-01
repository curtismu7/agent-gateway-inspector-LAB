import React from "react";
import { DECISION, OUTCOME } from "../lib/status.js";

export function DecisionBadge({ decision }) {
  const d = DECISION[decision] || { word: String(decision), glyph: "?", tone: "mute" };
  return <span className={`status status--${d.tone}`} data-decision={decision}><span aria-hidden="true">{d.glyph}</span> {d.word}</span>;
}

export function OutcomeBadge({ outcome }) {
  const o = OUTCOME[outcome] || { word: String(outcome), tone: "mute" };
  return <span className={`status status--${o.tone}`} data-outcome={outcome}>{o.word}</span>;
}
