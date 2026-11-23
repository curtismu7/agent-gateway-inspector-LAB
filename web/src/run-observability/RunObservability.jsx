import React, { useEffect, useMemo, useState } from "react";
import Json from "../components/JsonPane";
import "./run-observability.css";

/*
  "What each layer logged for this run" (Rule 27): the log lines one run left behind, in time order, for six layers.
  The family's one panel for it. The record is built server-side by runObservability.js (vendored beside the server code).

  <RunObservability record={record} source="mock" | "real" streams={[{ product, lives, streams }]} />
  Optional: title (heading).

  record = {                                     (collectRun() output; a lab's API answers it as JSON)
    runId, window: { from, to }, source: "mock" | "real", excerpt: true, truncated,
    rows: [{ id, at (ISO) | null, atExact?, layer, product, outcome: "allowed"|"refused"|"blocked"|"info",
             message, origin: "logged"|"simulated"|"response"|"not-logged", basis?: "measured-shape"|"unverified-shape",
             matchedBy?: "id"|"window", detail? }],
    coverage: { person|agent|authorize|privilege|gateway|resource: "logged"|"simulated"|"response"|"not-logged"|"unreachable" },
    reasons: { <layer>: string },                (why a layer is not-logged or unreachable)
    partial: { <layer>: true },                  (the search was cut at its cap: a not-logged layer is then "Not found (partial search)", absence is not proof)
    summary: { allowed, refused, blocked, info, unverified }   (an UNVERIFIED-shape row is counted in info and unverified, never in allowed/refused/blocked)
  }
  `source` is required: a page that omits it, or passes anything but "mock" or "real", gets an alert instead of a panel (a lab bug, never a guess).
  A lab's API that failed answers { error, message } (Rule 23): pass that as the record and the panel shows it.
  streams: where each product's logs live and where they stream (Rule 27). The lab's README says the same.

  HONESTY. origin "logged" = a real line read from the product's own log, with its own timestamp. "simulated" = the lab's mock computed it.
  "response" = a decision the lab already holds as an API response (a PingOne Authorize permit or deny and its policy): real, but it was NOT
  read from a log, so it is never tagged or counted as logged.
  "not-logged" = no line was found: the panel says so and never claims one. An "info" row is never counted as passed.
  Any JSON is drawn by the shared JsonPane (Rule 24): the lab vendors it at web/src/components/JsonPane.jsx.
*/

const LAYERS = [
  { id: "person", label: "Person", what: "who signed in" },
  { id: "agent", label: "Agent", what: "who acted for them" },
  { id: "authorize", label: "Authorize", what: "PingOne Authorize decisions" },
  { id: "privilege", label: "Privilege", what: "policy, AI Guard and approvals" },
  { id: "gateway", label: "Agent gateway", what: "allowed, refused or blocked" },
  { id: "resource", label: "Resource server", what: "the tool call served or refused" },
];
const LABEL = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));
const COVERAGE_LABEL = { logged: "Logged", simulated: "Simulated", response: "Response", "not-logged": "Not logged", unreachable: "Unreachable" };
const OUTCOME_LABEL = { allowed: "ALLOWED", refused: "REFUSED", blocked: "BLOCKED", info: "INFO" };
const GLYPH = { allowed: "✓", refused: "✕", blocked: "■", info: "i" };
const ORIGIN_LABEL = { logged: "logged", simulated: "simulated", response: "response", "not-logged": "not logged" };
const ORIGIN_NOTE = {
  logged: "A line read, read-only, from the product's own log, shown with that line's own timestamp. Ids, tokens and addresses are masked.",
  simulated: "Computed by the lab's mock. It was not read from any product log.",
  response: "A decision the lab already holds as the response of an API call. It is real, but it was not read from a product log, so it is not marked logged.",
  "not-logged": "No line was found for this layer in the run's window. The product may not log this event; nothing is claimed here.",
};
const HOT = ["outcome", "origin", "basis"];

// Everything shown is text: an API that answers an object where a string belongs must not crash the page.
const txt = (v) => {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return "[unreadable]"; } }
  return String(v);
};
const timeOf = (r) => (r.at ? r.atExact || r.at : "no timestamp");
const byTime = (a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0);
// A new run starts a clean panel: open rows and the layer filter belong to the run they were set on, so the panel is keyed by the run id
// (a record without one falls back to the record object itself).
const objIds = new WeakMap(); let seq = 0;
const keyOf = (r) => {
  if (!r || typeof r !== "object") return "none";
  if (typeof r.runId === "string" && r.runId) return `run:${r.runId}`;
  return `obj:${objIds.get(r) ?? (objIds.set(r, ++seq), seq)}`;
};
// Row ids are only trusted when unique: a repeated or missing id gets the row's position, so keys, open state and test ids never collide.
const normRows = (list) => {
  const used = new Set();
  return list.filter((r) => r && typeof r === "object").map((r, i) => {
    let id = txt(r.id) || `row-${i}`;
    if (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    return { ...r, id, layer: txt(r.layer), product: txt(r.product), message: txt(r.message), outcome: txt(r.outcome), origin: txt(r.origin), at: r.at ? txt(r.at) : null, atExact: r.atExact ? txt(r.atExact) : undefined };
  });
};
// The table keeps its native semantics. Only where the CSS turns table parts into blocks (narrow screens) do the ARIA roles go on, because some
// browsers drop the table semantics of a display:block table.
const NARROW = "(max-width: 760px)";
function useNarrow() {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW).matches : false);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

function Lane({ layer, rows, coverage, reason, partial, active, onPick }) {
  const own = rows.filter((r) => r.layer === layer.id && r.origin !== "not-logged");
  return (
    <li className="ro-lane" data-testid={`ro-lane-${layer.id}`} data-layer={layer.id} data-coverage={coverage || "unknown"}>
      <button type="button" className="ro-lane-name" aria-pressed={active} onClick={onPick} title={`Show only ${layer.label} rows`}>
        {layer.label}
      </button>
      <span className="ro-chip" data-coverage={coverage || "unknown"} data-partial={partial && coverage === "not-logged" ? "true" : undefined} data-testid={`ro-coverage-${layer.id}`}>
        {partial && coverage === "not-logged" ? "Not found (partial search)" : COVERAGE_LABEL[coverage] || "Not reported"}
      </span>
      <span className="ro-what">{layer.what}</span>
      <span className="ro-marks" aria-label={`${own.length} events`}>
        {own.map((r) => (
          <span key={r.id} className="ro-mark" data-outcome={r.outcome} title={`${timeOf(r)}: ${r.outcome}: ${r.message}`} role="img" aria-label={`${r.outcome} at ${timeOf(r)}`}>{GLYPH[r.outcome]}</span>
        ))}
      </span>
      {reason && <span className="ro-reason" data-testid={`ro-reason-${layer.id}`}>{txt(reason)}</span>}
    </li>
  );
}

function Detail({ row, hot }) {
  const { id, ...shown } = row; // eslint-disable-line no-unused-vars
  return (
    <div className="ro-detail" data-testid={`ro-detail-${row.id}`}>
      <p className="ro-muted">{ORIGIN_NOTE[row.origin]}</p>
      {row.basis === "unverified-shape" && (
        <p className="ro-muted" data-testid={`ro-unverified-${row.id}`}><strong>UNVERIFIED line shape.</strong> This kind of line has not been measured against a real product log, so read the outcome with care.</p>
      )}
      {row.matchedBy === "window" && <p className="ro-muted">Matched by the run's time window only, not by an id from the run.</p>}
      <Json value={shown} label="Log row" testId={`ro-row-${row.id}`} hot={hot} />
    </div>
  );
}

const LEGEND = [
  ["logged", "a line read, read-only, from the product's own log, with its own timestamp"],
  ["response", "a decision the lab holds as an API response; real, but not read from a log"],
  ["simulated", "computed by the lab's mock"],
  ["not-logged", "no line was found; nothing is claimed"],
];

function Legend() {
  return (
    <ul className="ro-legend" data-testid="ro-legend" aria-label="What the origin tags mean">
      {LEGEND.map(([o, t]) => <li key={o}><span className="ro-chip" data-origin={o}>{ORIGIN_LABEL[o]}</span> {t}</li>)}
    </ul>
  );
}

function Streams({ streams }) {
  const list = Array.isArray(streams) ? streams : [];
  return (
    <details className="ro-streams" data-testid="ro-streams">
      <summary>Where these logs live and where they stream</summary>
      {list.length === 0
        ? <p className="ro-muted" data-testid="ro-streams-empty">This lab has not said where its logs live or where they stream.</p>
        : (
          <ul>
            {list.map((s) => (
              <li key={txt(s?.product)}><strong>{txt(s?.product)}</strong>: lives in {txt(s?.lives)}; streams to {txt(s?.streams)}.</li>
            ))}
          </ul>
        )}
    </details>
  );
}

export default function RunObservability(props) {
  return <Panel key={keyOf(props.record)} {...props} />;
}

function Panel({ record, source: given, streams, title = "What each layer logged for this run", hot }) {
  const [layer, setLayer] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const keys = Array.isArray(hot) ? hot : HOT;
  const source = given === "mock" || given === "real" ? given : null;
  const narrow = useNarrow();
  const role = (r) => (narrow ? r : undefined);
  const rows = useMemo(() => (Array.isArray(record?.rows) ? normRows(record.rows).sort(byTime) : []), [record]);
  const shown = layer ? rows.filter((r) => r.layer === layer) : rows;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const head = (
    <>
      <h2>{title}</h2>
      <p className="ro-lead">Excerpt of this run's logs. Ids, tokens and addresses are masked.</p>
      {source && <p className="ro-muted" data-testid="ro-basis">
        {source === "real"
          ? "Real: each row marked logged is a line read, read-only, from the product's own log, with its own timestamp. A layer shows not logged when no line was found for this run; nothing is claimed for it. A row marked response is a decision the lab holds as an API response, not a log line."
          : "Simulated: the lab's mock computed these rows. None of them was read from a product log."}
      </p>}
    </>
  );

  let body;
  if (!source) {
    body = (
      <div className="ro-error" role="alert" data-testid="ro-no-source">
        <strong>Not shown.</strong> This panel needs source="mock" or source="real" (the page's current mode); it never guesses which one a record is.
      </div>
    );
  } else if (!record) {
    body = <p className="ro-muted" data-testid="ro-empty">Run the demo: the log lines each layer wrote for the run appear here, in time order.</p>;
  } else if (record.error) {
    body = (
      <div className="ro-error" role="alert" data-testid="ro-error">
        <strong>The run's logs could not be collected.</strong> {txt(record.message) || txt(record.error)}
      </div>
    );
  } else if (record.source && source && record.source !== source) {
    body = (
      <div className="ro-error" role="alert" data-testid="ro-mismatch">
        <strong>Not shown.</strong> This record was collected in {txt(record.source)} mode but the page is in {source} mode. Run again.
      </div>
    );
  } else {
    const counted = rows.filter((r) => r.origin !== "not-logged");
    // A row whose line shape is UNVERIFIED keeps its own outcome on the row, but is counted as information here, never as allowed, refused or blocked.
    const unverified = counted.filter((r) => r.basis === "unverified-shape").length;
    const n = (o) => counted.filter((r) => r.basis !== "unverified-shape" && r.outcome === o).length;
    const info = counted.filter((r) => r.basis === "unverified-shape" || r.outcome === "info").length;
    body = (
      <>
        <p className="ro-summary" data-testid="ro-summary">
          {counted.length === 0
            ? "No log lines in this excerpt."
            : `${n("allowed")} allowed, ${n("refused")} refused, ${n("blocked")} blocked, ${info} for information (information is not a pass${unverified ? `; ${unverified} UNVERIFIED-shape ${unverified === 1 ? "row is" : "rows are"} counted here whatever outcome ${unverified === 1 ? "it carries" : "they carry"}` : ""}).`}
          {" "}Window {txt(record.window?.from)} to {txt(record.window?.to)}.
        </p>
        <Legend />
        <ol className="ro-lanes" data-testid="ro-lanes" aria-label="Layers">
          {LAYERS.map((l) => (
            <Lane key={l.id} layer={l} rows={rows} coverage={record.coverage?.[l.id]} reason={record.reasons?.[l.id]} partial={Boolean(record.partial?.[l.id])}
              active={layer === l.id} onPick={() => setLayer(layer === l.id ? null : l.id)} />
          ))}
        </ol>
        {record.truncated && <p className="ro-muted" data-testid="ro-truncated">This excerpt was cut at the row or line cap; narrow the run's window to see the rest.</p>}
        {layer && (
          <p className="ro-muted" data-testid="ro-filter-note">
            Showing {shown.length} of {rows.length} rows ({LABEL[layer]} only).{" "}
            <button type="button" className="ro-link" onClick={() => setLayer(null)}>Show all layers</button>
          </p>
        )}
        {shown.length === 0
          ? <p className="ro-muted" data-testid="ro-no-rows">No rows to show. The layers above say why: a layer that is not logged or unreachable has no lines.</p>
          : (
            <table className="ro-table" data-testid="ro-table" role={role("table")}>
              <thead role={role("rowgroup")}>
                <tr role={role("row")}>{["Time", "Layer", "Product", "Outcome", "Message", "Origin"].map((h) => <th key={h} scope="col" role={role("columnheader")}>{h}</th>)}</tr>
              </thead>
              <tbody role={role("rowgroup")}>
                {shown.map((r) => {
                  const isOpen = open.has(r.id);
                  return (
                    <React.Fragment key={r.id}>
                      <tr role={role("row")} className="ro-row" data-testid={`ro-row-${r.id}-line`} data-layer={r.layer} data-outcome={r.outcome} data-origin={r.origin}>
                        <td role={role("cell")} data-label="Time" className="ro-time">
                          <button type="button" className="ro-expand" aria-expanded={isOpen} aria-controls={isOpen ? `ro-x-${r.id}` : undefined} onClick={() => toggle(r.id)}>
                            <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {timeOf(r)}
                          </button>
                        </td>
                        <td role={role("cell")} data-label="Layer">{LABEL[r.layer] || r.layer}</td>
                        <td role={role("cell")} data-label="Product">{r.product}</td>
                        <td role={role("cell")} data-label="Outcome"><span className="ro-chip" data-outcome={r.outcome}>{OUTCOME_LABEL[r.outcome] || r.outcome}</span></td>
                        <td role={role("cell")} data-label="Message" className="ro-msg">{r.message}</td>
                        <td role={role("cell")} data-label="Origin">
                          <span className="ro-chip" data-origin={r.origin}>{ORIGIN_LABEL[r.origin] || r.origin}</span>
                          {r.basis === "unverified-shape" && <span className="ro-tag">UNVERIFIED shape</span>}
                          {r.matchedBy === "window" && <span className="ro-tag">time window</span>}
                          {r.multiline && <span className="ro-tag">multi-line entry</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr role={role("row")} className="ro-xrow" id={`ro-x-${r.id}`}><td role={role("cell")} colSpan={6}><Detail row={r} hot={keys} /></td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
      </>
    );
  }

  return (
    <section className="ro" data-testid="run-observability" aria-label={title}>
      {head}
      {body}
      <Streams streams={streams} />
    </section>
  );
}
