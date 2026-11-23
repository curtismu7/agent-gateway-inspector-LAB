// Rule 27: the shared run-observability panel under the run controls (the lab's own wrapper; the panel itself is vendored and never edited).
//
// The server keeps one record per run and answers in its CURRENT mode only. A cheap head answer is polled; the record is read again only when the run, the
// mode or the run's cursor changes, never on every poll. While the record of a different run is being read the page says so and never shows the
// previous run's record. An attempt that began no run says so instead of showing the older record.
import React, { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { getRunHead, getRunObservability } from "../lib/api.js";

// Where this lab's own log line lives and where it can stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "Agent Gateway Inspector server (this lab)", lives: "the lab container's stdout: one line per row the stub gateway decides (layer, step, actor, result, cause, call, run, mode; never a credential), stamped when the stub decided", streams: "nowhere today: the family log collector's source list does not include this lab's container. If it did, the SIEM time would be Docker's wall-clock time per line; the time the stub decided stays inside the line" },
  { product: "Privilege, PingOne Authorize", lives: "not run by this lab in Mock: the gateway, the policy engine and the tool servers are stubs in one process. In Real the lab reads only the replies of one gateway check, never a Privilege log or its SIEM index", streams: "nothing to stream from this lab" },
];

const POLL_MS = 2000;
const TITLE = "What each layer logged for this run";
const Note = ({ testId, children, role }) => (
  <section className="ro" data-testid={testId} role={role} aria-label={TITLE}>
    <h2>{TITLE}</h2>
    <p className="ro-muted">{children}</p>
  </section>
);

const MOCK_NOTE = "Everything here was computed by the stub in one process; nothing was read from a product log. Under Agent is the stub agent registry. Under Person is the end-user layer of the four scope layers: a name in the stub issuer's table, since nobody signs in. Under Privilege is this lab's own policy engine, a stand-in for Privilege, with its approvals. Under Agent gateway is the stub gateway. Under Resource server is the stub tool server, only for a call that was forwarded. This lab does not call PingOne Authorize. Times are when the stub decided.";
const REAL_NOTE = "Real here is one gateway check: each reply the lab received from the door is a response row, stamped when the lab had it. The lab reads no gateway log and no tool server, so nothing is marked logged, and no person or agent decision is claimed. Scenarios always run through the in-process stub: their record is shown in Mock.";

// runId: the run this page started (a Mock scenario run), or null. attempt: why the last attempt began no run, or null. pollMs: for tests.
export default function RunObs({ runId, attempt, pollMs = POLL_MS }) {
  const [source, setSource] = useState("mock"); // the server's current mode, as its last answer said
  const [head, setHead] = useState(null); // { source, runId, cursor, open } | { error, message } | null before the first answer
  const [answer, setAnswer] = useState(null); // { runKey, source, record, message, open, noReply }
  const asked = source === "real" ? undefined : runId; // a Real check is not named by the page: it shows the newest of the mode

  useEffect(() => {
    if (attempt) return undefined;
    let live = true;
    const poll = () => getRunHead(asked).then(
      (h) => { if (!live) return; setSource(h.source); setHead((p) => (p && !p.error && p.source === h.source && p.runId === h.runId && p.cursor === h.cursor && p.open === h.open ? p : h)); },
      (e) => { if (live) setHead({ error: e.code || "unreachable", message: e.message || "Could not reach the server." }); },
    );
    poll();
    const t = setInterval(poll, pollMs);
    return () => { live = false; clearInterval(t); };
  }, [asked, attempt, pollMs]);

  const key = head && !head.error ? `${head.source}|${head.runId}|${head.cursor}|${head.open}` : null;
  const runKey = head && !head.error ? `${head.source}|${head.runId}` : null;
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    getRunObservability(head.runId ?? asked).then(
      (b) => { if (live) setAnswer({ runKey, source: b.source, record: b.record ?? null, message: b.message, open: b.open === true, noReply: b.noReply || [] }); },
      (e) => { if (live) setAnswer({ runKey, source: head.source, record: { error: e.code || "unreachable", message: e.message || "Could not reach the server." }, open: false, noReply: [] }); },
    );
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the head's own fields are what `key` is made of; `asked` only matters while no run was found

  if (attempt) return <Note testId="ro-no-run">That attempt began no run, so there is nothing to show for it: {attempt.slice(0, 300).replace(/[.\s]*$/, ".")} The record of an earlier run is not shown here.</Note>;
  if (head?.error) return <RunObservability record={{ error: head.error, message: head.message }} source={source} streams={RUN_OBS_STREAMS} />;
  if (!head || !answer || answer.runKey !== runKey) return <Note testId="ro-loading" role="status">Collecting this run's logs…</Note>;
  return (
    <>
      <RunObservability record={answer.record} source={answer.source} streams={RUN_OBS_STREAMS} />
      {answer.record === null && answer.message && <p className="ro-muted" data-testid="ro-none">{answer.message}</p>}
      {answer.open && <p className="ro-muted" data-testid="ro-open">A call of this run is still waiting for a human: its answer joins this record when it comes.</p>}
      {answer.noReply.map((n) => <p key={n} className="ro-muted" data-testid="ro-no-reply">{n}.</p>)}
      <p className="ro-muted ro-lab-note" data-testid="ro-lab-note">{answer.source === "real" ? REAL_NOTE : MOCK_NOTE}</p>
    </>
  );
}
