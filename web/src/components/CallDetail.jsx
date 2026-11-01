import React, { useEffect, useState } from "react";
import { DecisionBadge, OutcomeBadge } from "./Badges.jsx";
import { Untrusted, pretty } from "./Untrusted.jsx";
import { HOLD_STATE, LAYERS, LAYER_RESULT, REASON, RULE } from "../lib/status.js";

function Countdown({ iso }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  return <span>{s > 0 ? `${s}s left` : "expiring now"}</span>;
}

// The four scope checks in the order the gateway makes them. Each shows a word and a glyph, never colour alone.
function ScopeStrip({ layers, claims }) {
  return (
    <div className="scope-strip" data-testid="scope-strip">
      <h3>Four scope checks <span className="muted small">(read from the verified token; Ping release claim, UNVERIFIED on our tenant)</span></h3>
      <ol className="scope-strip__list" aria-label="Scope checks in order">
        {LAYERS.map((l, i) => {
          const r = LAYER_RESULT[layers[l.id]] || LAYER_RESULT.skipped;
          return (
            <li key={l.id} className="scope-strip__item" data-state={layers[l.id] || "skipped"} data-layer={l.id} title={l.asks}>
              <span className="scope-strip__name">{i + 1}. {l.label}</span>
              <span className="scope-strip__result"><span aria-hidden="true">{r.glyph}</span> {r.word}</span>
            </li>
          );
        })}
      </ol>
      {claims && (
        <dl className="kv scope-strip__claims">
          <dt>Token</dt><dd><Untrusted text={claims.subject} plain /></dd>
          <dt>Application</dt><dd><Untrusted text={claims.application} plain /></dd>
          <dt>Surface</dt><dd><Untrusted text={claims.surface} plain /></dd>
          <dt>End user</dt><dd><Untrusted text={claims.endUser} plain /></dd>
          <dt>Human present</dt><dd>{claims.attended ? "Yes: attended, the call waits in the session" : "No: unattended, the gateway refuses at once with a reference and an expiry"}</dd>
        </dl>
      )}
    </div>
  );
}

export default function CallDetail({ call, headingRef, busy, onDecide, onRetry, error }) {
  if (!call) {
    return (
      <section className="detail card" aria-labelledby="detail-title">
        <h2 id="detail-title" ref={headingRef} tabIndex={-1}>Call detail</h2>
        <p className="muted">Select a call to see the agent, the tool, the arguments, the rule that matched and why.</p>
      </section>
    );
  }
  const pending = call.outcome === "pending";
  const hold = call.hold;
  const holdPending = hold?.state === "pending" && call.outcome === "held";
  return (
    <section className="detail card" aria-labelledby="detail-title" data-testid="detail">
      <h2 id="detail-title" ref={headingRef} tabIndex={-1}>Call <span className="mono">{call.id}</span></h2>
      <p className="badges"><DecisionBadge decision={call.decision} /> <OutcomeBadge outcome={call.outcome} /></p>
      <dl className="kv">
        <dt>Agent</dt><dd><Untrusted text={call.agentId} plain /></dd>
        <dt>Tool</dt><dd><Untrusted text={call.tool} plain /></dd>
        <dt>Scope needed</dt><dd>{call.requiredScope ? <Untrusted text={call.requiredScope} plain /> : "none (stopped before the scope check)"}</dd>
        <dt>Matched rule</dt><dd>{call.ruleId ? <><span className="mono">{call.ruleId}</span><span className="muted small"> {RULE[call.ruleId] || ""}</span></> : "none: decided before any rule, or no rule matched"}</dd>
        <dt>Why</dt><dd><span className="mono">{call.reason}</span><span className="muted small"> {REASON[call.reason] || ""}</span></dd>
        <dt>Scenario</dt><dd>{call.scenarioId ? <Untrusted text={call.scenarioId} plain /> : "none"}</dd>
        <dt>At</dt><dd className="mono">{call.at}</dd>
      </dl>
      {call.layers && <ScopeStrip layers={call.layers} claims={call.claims} />}
      <h3>Arguments <span className="muted small">(shown as text; hidden characters are made visible)</span></h3>
      <Untrusted text={call.args === null ? "(not an object the gateway accepts)" : pretty(call.args)} block />

      {call.pause && (
        <div className="pause" data-testid="pause">
          <h3>Pause</h3>
          <p>State: <strong>{call.pause.state}</strong>{pending && <> &middot; <Countdown iso={call.pause.expiresAt} /></>}</p>
          {pending && (
            <>
              <p className="muted small">This page holds the one-shot approval code for you because the browser on loopback is the human in this demo. Another website cannot send this request: the server refuses cross-origin writes.</p>
              <div className="row">
                <button type="button" className="btn primary" disabled={busy} onClick={() => onDecide("approve")}>Approve and forward</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => onDecide("deny")}>Deny</button>
              </div>
            </>
          )}
        </div>
      )}
      {hold && (
        <div className="pause hold" data-testid="hold">
          <h3>Hold for a human <span className="muted small">(unattended: no connection is kept open)</span></h3>
          <p>State: <strong>{HOLD_STATE[hold.state] || hold.state}</strong>{(hold.state === "pending" || hold.state === "approved") && <> &middot; <Countdown iso={hold.expiresAt} /></>}</p>
          <dl className="kv">
            <dt>Reference</dt><dd className="mono" data-testid="hold-ref">{hold.ref}</dd>
            <dt>Bound to</dt><dd className="mono" title={hold.argsHash}>{hold.argsHash.slice(0, 16)}&hellip; <span className="muted small">(hash of agent, tool, token and every argument)</span></dd>
            <dt>Expires</dt><dd className="mono">{hold.expiresAt}</dd>
            {hold.grantTtlSec !== null && <><dt>Grant window</dt><dd>{hold.grantTtlSec} s after approval</dd></>}
            {hold.consumedAt && <><dt>Spent by</dt><dd><span className="mono">{hold.consumedByCallId}</span> at <span className="mono">{hold.consumedAt}</span></dd></>}
            {hold.deniedBy && <><dt>Denied by</dt><dd>{hold.deniedBy}</dd></>}
          </dl>
          {holdPending && (
            <>
              <p className="muted small">The agent was refused at once with this reference. Approving it forwards nothing: it lets the agent&apos;s exact retry through, once.</p>
              <div className="row">
                <button type="button" className="btn primary" disabled={busy} onClick={() => onDecide("approve")}>Approve this exact call</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => onDecide("deny")}>Deny</button>
              </div>
            </>
          )}
          {(hold.state === "pending" || hold.state === "approved" || hold.state === "consumed") && (
            <div className="row hold__retry">
              <button type="button" className="btn" disabled={busy} onClick={onRetry}>{hold.state === "consumed" ? "Replay the same approval" : "Agent retries the exact call"}</button>
              <span className="muted small">{hold.state === "consumed" ? "It was spent by the first retry, so this is refused." : hold.state === "pending" ? "Before a human answers, this is refused." : "The retry is evaluated like any call; the approval is only an input."}</span>
            </div>
          )}
          <details className="hold__names">
            <summary>Where these field names come from</summary>
            <p className="small">Console swagger name, 2026-10-31, schema only (the schema proves the name exists, not the behaviour): reference = RequestID, bound-to hash = FieldHash, expires = ExpiresAt, grant window = GrantTTLSec, decided = DecidedAt, spent = ConsumedAt and ConsumedByRequestID, denied by = DeniedBy, expired = ExpiredAt. The four scope checks, the hold outcome and attended versus unattended have no swagger name: lab-invented. How the hash is computed and what a retry must match are lab readings.</p>
          </details>
        </div>
      )}
      {error && <p className="alert" role="alert">{error}</p>}

      {call.upstream && (
        <>
          <h3>Upstream answer</h3>
          {call.upstream.ok === false
            ? <p>The upstream did not answer: <Untrusted text={call.upstream.error || "error"} plain /></p>
            : call.upstream.result !== undefined ? <Untrusted text={pretty(call.upstream.result)} block /> : <p className="muted">Forwarded; the answer is shown in the detail view only.</p>}
        </>
      )}
    </section>
  );
}
