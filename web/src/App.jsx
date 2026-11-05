import React, { useCallback, useEffect, useRef, useState } from "react";
import ShelfLink from "./components/ShelfLink.jsx";
import { decide, getAudit, getCall, getCalls, getHealth, getInfo, getScenarios, postReset, retryCall, runScenario, verifyAudit } from "./lib/api.js";
import { DECISION, ERROR_TEXT, REASON } from "./lib/status.js";
import CallList from "./components/CallList.jsx";
import CallDetail from "./components/CallDetail.jsx";
import AuditPanel from "./components/AuditPanel.jsx";
import Flow from "./components/Flow.jsx";
import Story from "./components/Story.jsx";

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const initialTheme = () => safe(() => localStorage.getItem("agi-theme"), null)
  || (safe(() => window.matchMedia("(prefers-color-scheme: dark)").matches, false) ? "dark" : "light");
const POLL_MS = 2000;
const count = (calls, d) => calls.filter((c) => c.decision === d).length;

const LIVE_REFUSED = "Live is refused: this app has no live gateway to talk to, because the Ping release it simulates is not on our tenant. It stays in mock.";

// Shown on every tab, presenter mode included. The feature this app simulates is a Ping release claim; nothing here checks it against a real tenant.
// It always names the mode the page is in, the same word the header shows.
function ReleaseBanner({ mode }) {
  return (
    <section className="banner" role="region" aria-label="Release claim notice" data-testid="release-banner" data-state={mode === "live" ? "live" : "mock"}>
      <strong className="banner__mode">{mode === "live" ? "Live mode." : "Mock mode."}</strong>{" "}
      <strong>Ping release claim (2026-11-02), UNVERIFIED on our tenant.</strong>{" "}
      Four layered scope checks, a third outcome that holds for a human, and approvals that work once and are bound to the exact call are what the release is claimed to do. This app simulates them with a stub gateway and stub tool servers on loopback; nothing real is called. Live is refused: there is no live gateway, so there is no live path until the release is on our tenant.
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [mode, setMode] = useState("mock"); // mock until the server says live can be selected; it never does
  const [info, setInfo] = useState(null);
  const [liveNote, setLiveNote] = useState("");
  const [presenter, setPresenter] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [view, setView] = useState("inspector");
  const [health, setHealth] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState("");
  const [hold, setHold] = useState(true);
  const [calls, setCalls] = useState([]);
  const [audit, setAudit] = useState({ entries: [], size: 0 });
  const [verify, setVerify] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [lastRun, setLastRun] = useState(null);
  const [storyNow, setStoryNow] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const detailHeading = useRef(null);
  const sel = useRef(null);
  const healthRef = useRef(null);
  sel.current = selectedId;
  healthRef.current = health;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    safe(() => localStorage.setItem("agi-theme", theme));
  }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([getCalls(), getAudit()]);
      setPollError("");
      if (healthRef.current?.unreachable) getHealth().then(setHealth, () => {}); // the API is back: drop the stale banner
      setCalls(c.calls);
      setAudit({ entries: a.entries, size: a.size });
      if (sel.current) {
        const found = c.calls.find((x) => x.id === sel.current);
        if (!found) { setSelectedId(null); setDetail(null); } else {
          try { setDetail((await getCall(sel.current)).call); } catch { /* keep the old detail */ }
        }
      }
      return { calls: c.calls, auditSize: a.size };
    } catch (e) { setPollError(`Could not reach the gateway API: ${e.message}`); return null; }
  }, []);

  useEffect(() => {
    getHealth().then(setHealth, () => setHealth({ unreachable: true }));
    getInfo().then((i) => { setInfo(i); if (i.requested === "live") setLiveNote(LIVE_REFUSED); }, () => setInfo(null));
    getScenarios().then((d) => { setScenarios(d.scenarios); setScenarioId(d.scenarios[0]?.id || ""); }, (e) => setError(`Could not load the scenarios: ${e.message}`));
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const select = (id, el) => {
    setSelectedId(id); setDetailError(""); setDetail(null);
    sel.current = id;
    getCall(id).then((d) => { if (sel.current === id) setDetail(d.call); }, () => setDetailError("Could not load that call."));
    if (el) setTimeout(() => detailHeading.current?.focus(), 0);
  };

  const summarize = (r) => {
    const cs = r.calls;
    const base = `Ran "${r.scenario.title}": ${cs.length} call${cs.length === 1 ? "" : "s"}, ${count(cs, "allow")} allow, ${count(cs, "deny")} deny, ${count(cs, "pause")} hold for a human.`;
    if (cs.some((c) => c.outcome === "pending" || (c.outcome === "held" && c.hold?.state === "pending"))) return `${base} The held call is waiting for you to approve or deny it.`;
    if (r.held) return `${base} The held call is no longer waiting: ${cs.filter((c) => c.decision === "pause").map((c) => c.outcome).join(", ")}.`;
    return `${base} ${r.matched ? "Matches the expected result." : "Does NOT match the expected result."}`;
  };

  const run = useCallback(async (holdIt) => {
    setBusy(true); setError(""); setMessage("Running");
    try {
      const r = await runScenario(scenarioId, holdIt);
      setLastRun(r); setVerify(null);
      setMessage(summarize(r));
      const snap = await refresh();
      const first = r.calls.find((c) => c.outcome === "pending" || c.outcome === "held") || r.calls[0];
      if (first) select(first.id);
      return { ...r, auditSize: snap?.auditSize ?? 0 };
    } catch (e) { setMessage(""); setError(e.status === 429 ? "A scenario is already running. Try again in a moment." : `Run failed: ${e.message}`); return null; } finally { setBusy(false); }
  }, [scenarioId, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (decision) => {
    const code = detail?.hold?.approvalCode ?? detail?.pause?.approvalCode;
    if (!code) { setDetailError("No approval code is available for this call."); return; }
    setBusy(true); setDetailError("");
    try {
      await decide(detail.id, decision, code);
      if (detail.hold) setMessage(decision === "approve" ? `Approved ${detail.id}: nothing was forwarded. The agent can now retry the exact call once.` : `Denied ${detail.id}: it was never forwarded.`);
      else setMessage(decision === "approve" ? `Approved ${detail.id}: the gateway forwarded it to the upstream.` : `Denied ${detail.id}: it was never forwarded.`);
    } catch (e) { setDetailError(ERROR_TEXT[e.code] || `Could not answer: ${e.message}`); } finally {
      setBusy(false);
      await refresh();
      setTimeout(() => detailHeading.current?.focus(), 0); // the buttons just went away: keep keyboard focus in the detail
    }
  };

  const agentRetry = async () => {
    if (!detail?.hold) return;
    setBusy(true); setDetailError("");
    try {
      const { call: again } = await retryCall(detail.id);
      const word = DECISION[again.decision]?.word || again.decision;
      setMessage(`The agent retried ${detail.id} as ${again.id}: ${word}, ${again.reason}. ${REASON[again.reason] || ""}`);
    } catch (e) { setDetailError(ERROR_TEXT[e.code] || `Could not retry: ${e.message}`); } finally {
      setBusy(false);
      await refresh();
    }
  };

  const doVerify = async () => {
    setBusy(true);
    try {
      const v = await verifyAudit();
      setVerify(v);
      setMessage(v.ok ? `Audit chain verified: ${v.length} entries.` : `Audit chain TAMPERED at entry ${v.firstBadSeq}.`);
    } catch (e) { setError(`Verify failed: ${e.message}`); } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setError("");
    try {
      await postReset();
      setResetSignal((n) => n + 1); // the diagram boxes go back to where they started
      setLastRun(null); setVerify(null); setSelectedId(null); setDetail(null); setCalls([]);
      await refresh();
      setMessage("Reset: calls cleared and a new audit epoch started. The old trail is discarded and the new one records that.");
    } catch (e) { setError(`Reset failed: ${e.message}`); } finally { setBusy(false); }
  };

  // Live can be selected only when the server says every live guard passes. None can, so the click shows why and the page stays in mock.
  const selectMode = (m) => {
    if (m === "mock") { setMode("mock"); setLiveNote(""); return; }
    if (info?.live?.available === true) { setMode("live"); setLiveNote(""); return; }
    setMode("mock");
    setLiveNote(LIVE_REFUSED);
  };
  // P enters presenter mode and Esc leaves it, unless the key is for a form control. The banner and the mode stay.
  useEffect(() => {
    const on = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || "")) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const dark = theme === "dark";
  const scenario = scenarios.find((s) => s.id === scenarioId);
  return (
    <div className="app" data-presenter={presenter ? "on" : undefined}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="top">
        <h1>Agent Gateway Inspector LAB</h1>
        <span className="chip" data-testid="mode-badge">Mode: {mode === "live" ? "Live" : "Mock"}<span className="sr-only">: a stub gateway and stub tool servers on loopback, nothing real</span></span>
        <nav className="top__nav" aria-label="Views">
          <button type="button" className="tab" aria-pressed={view === "inspector"} onClick={() => setView("inspector")}>Inspector</button>
          <button type="button" className="tab" aria-pressed={view === "diagram"} onClick={() => setView("diagram")}>Diagram</button>
        </nav>
        <div className="top__tools">
            <ShelfLink />
          {!presenter && (
            <div className="seg" role="group" aria-label="Mode">
              <button type="button" aria-pressed={mode === "mock"} onClick={() => selectMode("mock")} data-testid="mode-mock">Mock</button>
              <button type="button" aria-pressed={mode === "live"} onClick={() => selectMode("live")} data-testid="mode-live">Live</button>
            </div>
          )}
          {!presenter && <button type="button" className="btn" onClick={reset} disabled={busy}>Reset</button>}
          <button type="button" className="btn" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} title="P to enter, Esc to leave">{presenter ? "Exit presenter" : "Presenter"}</button>
          {!presenter && <button type="button" className="btn" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={`Switch to ${dark ? "light" : "dark"} theme`}>{dark ? "Light" : "Dark"}</button>}
        </div>
      </header>
      <ReleaseBanner mode={mode} />
      {liveNote && <p className="alert mode-note" role="status" data-testid="live-note">{liveNote}{info?.requested === "live" ? " GATEWAY_INSPECTOR_MODE=live is set and is refused too." : ""}</p>}
      {health?.unreachable && <div className="banner" data-state="bad" role="alert">Cannot reach the gateway API. Is the server running?</div>}
      {health && !health.unreachable && health.state !== "ready" && <div className="banner" data-state="warn" role="alert">Server health is {health.state}. Run <code>npm run doctor</code>.</div>}
      <main id="main" tabIndex={-1} className="page">
        <section className="card picker" aria-label="Run a scenario">
          <label htmlFor="scenario-select">Scenario</label>
          <div className="picker__field">
            <select id="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} disabled={!scenarios.length}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          </div>
          <label className="picker__check">
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            Wait for me to answer a held call
          </label>
          <button type="button" className="primary" onClick={() => run(hold)} disabled={busy || !scenarioId}>Run</button>
          <p className="muted small picker__desc">{scenario ? scenario.description : ""}</p>
        </section>
        <div role="status" aria-live="polite" className="scan-status" data-testid="run-status">{message}</div>
        {error && <p className="alert" role="alert">{error}</p>}
        {pollError && <p className="alert" role="alert">{pollError}</p>}

        {view === "inspector" ? (
          <>
            <div className="workspace">
              <section aria-labelledby="calls-title" className="listcol">
                <h2 id="calls-title">Calls <span className="muted small">{calls.length} in the buffer</span></h2>
                <CallList calls={calls} selectedId={selectedId} onSelect={select} />
              </section>
              <CallDetail call={detail} headingRef={detailHeading} busy={busy} onDecide={answer} onRetry={agentRetry} error={detailError} />
            </div>
            <AuditPanel entries={audit.entries} size={audit.size} verify={verify} onVerify={doVerify} busy={busy} />
          </>
        ) : (
          <Flow run={lastRun} auditSize={audit.size} callCount={calls.length} scenarioTitle={scenario?.title} theme={theme} busy={busy}
            onSimulate={() => run(false)} onStep={setStoryNow} resetSignal={resetSignal} />
        )}
        <Story active={view === "diagram" ? storyNow : -1} />
      </main>
    </div>
  );
}
