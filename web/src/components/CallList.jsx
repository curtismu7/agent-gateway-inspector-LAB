import React from "react";
import { DecisionBadge, OutcomeBadge } from "./Badges.jsx";
import { Untrusted } from "./Untrusted.jsx";

export default function CallList({ calls, selectedId, onSelect }) {
  if (!calls.length) {
    return <p className="empty muted">No calls yet. Pick a scenario and press Run.</p>;
  }
  const newest = [...calls].reverse();
  return (
    <ul className="calls plain" aria-label="Calls, newest first">
      {newest.map((c) => (
        <li key={c.id}>
          <button type="button" className={`call call--${c.decision}`} aria-current={c.id === selectedId ? "true" : undefined}
            onClick={(e) => onSelect(c.id, e.currentTarget)} data-call-id={c.id}>
            <span className="call__top"><span className="mono">{c.id}</span><DecisionBadge decision={c.decision} /></span>
            <span className="call__mid"><Untrusted text={c.agentId} plain /> <span aria-hidden="true">&rarr;</span><span className="sr-only"> calls </span> <Untrusted text={c.tool} plain /></span>
            <span><OutcomeBadge outcome={c.outcome} /></span>
          </button>
        </li>
      ))}
    </ul>
  );
}
