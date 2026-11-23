// Rule 27: the shared run-observability panel under the run controls (the lab's own wrapper; the panel itself is vendored and never edited).
//
// The server keeps one record per run and answers in its CURRENT mode only. A cheap head answer is polled; the record is read again only when the run, the
// mode or the run's cursor changes, never on every poll. Whatever is on screen is the record of the run this page now asks for: until the head and the
// record of THAT run have both answered, the page says it is collecting and never shows the previous run's record. An answer that is not what the server
// sends (no JSON, the wrong shape) is an alert, never a panel stuck on "Collecting". An attempt that began no run says so instead of showing the older record.
import React, { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { getRunHead, getRunObservability } from "../lib/api.js";

// Where this lab's own log line lives and where it can stream (the README says the same).
export const LOG_STREAMS = [
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

const MOCK_NOTE = "Counts above are check rows, not calls: one call makes several checks (the registry, the end-user layer, the policy engine), and the gateway row repeats the policy engine's decision as information, so one decision is never counted twice. Everything here was computed by the stub in one process; nothing was read from a product log. Under Agent is the stub agent registry. Under Person is the end-user layer of the four scope layers: a name in the stub issuer's table, since nobody signs in. Under Privilege is this lab's own policy engine, a stand-in for Privilege, with its approvals. Under Agent gateway is the stub gateway. Under Resource server is the stub tool server, only for a call that was forwarded. This lab does not call PingOne Authorize. Times are when the stub decided.";
const REAL_NOTE = "Counts above are rows, one per reply the lab received. Real here is one gateway check: each reply the lab received from the door is a response row, stamped when the lab had it. The lab reads no gateway log and no tool server, so nothing is marked logged, and no person or agent decision is claimed. Scenarios always run through the in-process stub: their record is shown in Mock.";

// What the server answers must be an object of the expected shape; api.js gives null for a 200 that is not JSON (an error page, an empty body).
const isMode = (v) => v === "mock" || v === "real";
const headOk = (h) => h !== null && typeof h === "object" && isMode(h.source) && (h.runId === null || typeof h.runId === "string");
const answerOk = (b) => b !== null && typeof b === "object" && isMode(b.source) && "record" in b && (b.record === null || (typeof b.record === "object" && !Array.isArray(b.record)));
const refused = (e) => ({ error: e?.code || "bad_answer", message: e?.message || "The server's reply was not what this page expects (no JSON, or the wrong shape), so no run record can be shown." });
const unreachable = (e) => (e?.code ? e : { code: "unreachable", message: e?.message || "Could not reach the server." });

// runId: the run this page started (a Mock scenario run), or null. attempt: why the last attempt began no run, or null. pollMs: for tests.
export default function RunObs({ runId, attempt, pollMs = POLL_MS }) {
  const [source, setSource] = useState("mock"); // the server's current mode, as its last answer said
  const [head, setHead] = useState(null); // { asked, source, runId, cursor, open } | { asked, error, message } | null before the first answer
  const [answer, setAnswer] = useState(null); // { runKey, source, record, message, open, noReply }
  const [retry, setRetry] = useState(0); // counts the polls made while the last record answer was an alert, so the record is asked for again
  const asked = source === "real" ? undefined : runId || undefined; // a Real check is not named by the page: it shows the newest of the mode

  useEffect(() => {
    if (attempt) return undefined;
    let live = true;
    const poll = () => getRunHead(asked).then((h) => {
      if (!live) return;
      if (!headOk(h)) { setHead({ asked, ...refused() }); return; }
      setSource(h.source);
      setHead((p) => (p && !p.error && p.asked === asked && p.source === h.source && p.runId === h.runId && p.cursor === h.cursor && p.open === h.open ? p : { ...h, asked }));
    }).catch((e) => { if (live) setHead({ asked, ...refused(unreachable(e)) }); });
    poll();
    const t = setInterval(poll, pollMs);
    return () => { live = false; clearInterval(t); };
  }, [asked, attempt, pollMs]);

  // Both keys name the run this page asks for, so a head or a record of the previous ask is never taken for the current one.
  const key = head && !head.error ? `${head.asked}|${head.source}|${head.runId}|${head.cursor}|${head.open}|${retry}` : null;
  const runKey = head && !head.error ? `${head.asked}|${head.source}|${head.runId}` : null;
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const fail = (e) => { if (live) setAnswer({ runKey, source: head.source, record: refused(unreachable(e)), open: false, noReply: [] }); };
    getRunObservability(head.runId ?? head.asked).then((b) => {
      if (!live) return;
      if (!answerOk(b)) { setAnswer({ runKey, source: head.source, record: refused(), open: false, noReply: [] }); return; }
      setAnswer({ runKey, source: b.source, record: b.record, message: typeof b.message === "string" ? b.message : undefined, open: b.open === true, noReply: Array.isArray(b.noReply) ? b.noReply.filter((n) => typeof n === "string") : [] });
    }).catch(fail);
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the head's own fields are what `key` is made of

  const alerting = Boolean(answer?.record?.error);
  useEffect(() => {
    if (!alerting) return undefined;
    const t = setInterval(() => setRetry((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [alerting, pollMs]);

  if (attempt) return <Note testId="ro-no-run">That attempt began no run, so there is nothing to show for it: {attempt.slice(0, 300).replace(/[.\s]*$/, ".")} The record of an earlier run is not shown here.</Note>;
  if (head?.error && head.asked === asked) return <RunObservability record={{ error: head.error, message: head.message }} source={source} streams={LOG_STREAMS} />;
  if (!head || head.error || head.asked !== asked || !answer || answer.runKey !== runKey) return <Note testId="ro-loading" role="status">Collecting this run's logs…</Note>;
  return (
    <>
      <RunObservability record={answer.record} source={answer.source} streams={LOG_STREAMS} />
      {answer.record === null && answer.message && <p className="ro-muted" data-testid="ro-none">{answer.message}</p>}
      {answer.open && <p className="ro-muted" data-testid="ro-open">A call of this run is still waiting for a human: its answer joins this record when it comes.</p>}
      {answer.record?.partial?.gateway && <p className="ro-muted" data-testid="ro-partial"><strong>Partial check.</strong> The Agent gateway lane above holds only some of this check's replies; what is missing is named below and in the lane.</p>}
      {answer.noReply.map((n) => <p key={n} className="ro-muted" data-testid="ro-no-reply">{n}.</p>)}
      <p className="ro-muted ro-lab-note" data-testid="ro-lab-note">{answer.source === "real" ? REAL_NOTE : MOCK_NOTE}</p>
    </>
  );
}
