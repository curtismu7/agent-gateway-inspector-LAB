import React from "react";
import { shortHash } from "../lib/format.js";
import { Untrusted } from "./Untrusted.jsx";

const REASONS = {
  hash_mismatch: "an entry's contents no longer match its hash",
  chain_broken: "an entry does not link to the one before it",
  sequence_gap: "an entry is missing or out of order",
  malformed_entry: "an entry is malformed",
};

export default function AuditPanel({ entries, size, verify, onVerify, busy }) {
  const shown = [...entries].reverse().slice(0, 100);
  return (
    <section className="card audit" aria-labelledby="audit-title">
      <div className="audit__head">
        <h2 id="audit-title">Audit trail <span className="muted small">{size} entr{size === 1 ? "y" : "ies"}, append-only</span></h2>
        <button type="button" className="btn" onClick={onVerify} disabled={busy}>Verify chain</button>
      </div>
      <div role="status" aria-live="polite" data-testid="verify-result" className="verify-slot">
        {verify && (verify.ok
          ? <p className="verify verify--ok"><span aria-hidden="true">{"✓"}</span> Chain verified: {verify.length} entr{verify.length === 1 ? "y" : "ies"}, head #{verify.headSeq}, {shortHash(verify.headHash)}. Every entry links to the one before it.</p>
          : <p className="verify verify--bad" role="alert"><span aria-hidden="true">{"✕"}</span> TAMPERED: the chain fails at entry #{verify.firstBadSeq}: {REASONS[verify.reason] || verify.reason}.</p>)}
      </div>
      {shown.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
        <div className="table-wrap" role="region" aria-label="Audit entries (scrolls sideways)" tabIndex={0}>
          <table className="inv">
            <caption className="sr-only">Newest audit entries first, at most 100</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Event</th><th scope="col">Call</th><th scope="col">Detail</th><th scope="col">Hash</th></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.seq}>
                  <th scope="row">{e.seq}</th>
                  <td className="mono">{e.type}</td>
                  <td className="mono">{e.callId || "-"}</td>
                  <td><Untrusted text={summary(e)} plain /></td>
                  <td className="mono">{shortHash(e.hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function summary(e) {
  const d = e.data || {};
  if (e.type === "decision") return `${d.agentId} ${d.tool}: ${d.decision} (${d.reason})`;
  if (e.type === "reset") return `earlier entries discarded: ${d.discardedLength ?? 0}`;
  return [d.agentId, d.tool, d.error].filter(Boolean).join(" ");
}
