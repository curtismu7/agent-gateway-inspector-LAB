// Rule 27 on this page: the run record under the run controls. The panel itself is the vendored shared one (its own tests live beside it);
// these tests pin this lab's wrapper: which run it asks for, when it reads again, what it says while it waits and when nothing began.
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import RunObs from "../components/RunObs.jsx";
import { setJsonView } from "../components/JsonPane.jsx";
import { mockRecord } from "../run-observability/fixtures.js";
import { call, paused, entry, DIAGRAM_DOCS } from "./fixtures.js";

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const WINDOW = { from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:00:09.000Z" };
// The panel does not print the run id, so each record's first row carries it: that is how a test tells which run is on screen.
const mockOf = (runId) => ({ ...mockRecord, runId, source: "mock", rows: mockRecord.rows.map((r, i) => (i === 0 ? { ...r, message: `Mock sign-in in ${runId}` } : r)) });
const realOf = (runId) => ({
  runId, window: WINDOW, source: "real", excerpt: true, truncated: false,
  rows: [
    { id: "r1", at: "2026-11-22T10:00:01.000Z", atExact: "2026-11-22T10:00:01.000Z", layer: "gateway", product: "Privilege door reply", outcome: "allowed", message: `The door answered tools/list for the agent key with 2 tools (${runId}).`, origin: "response" },
    { id: "r2", at: "2026-11-22T10:00:02.000Z", atExact: "2026-11-22T10:00:02.000Z", layer: "gateway", product: "Privilege door reply", outcome: "refused", message: "The door answered the refusal probe with a JSON-RPC error: policy denied", origin: "response" },
    { id: "n-person", at: null, layer: "person", product: "none", outcome: "info", message: "This lab signs nobody in.", origin: "not-logged" },
  ],
  coverage: { person: "not-logged", agent: "not-logged", authorize: "not-logged", privilege: "not-logged", gateway: "response", resource: "not-logged" },
  reasons: { person: "This lab signs nobody in.", agent: "x", authorize: "x", privilege: "x", resource: "x" },
  summary: { allowed: 1, refused: 1, blocked: 0, info: 0, unverified: 0 },
});

// A fake server for the two run-observability routes. `runs` is what the server keeps; `source` is its current mode.
function fakeRuns(init = {}) {
  const st = { source: "mock", runs: { mock: [{ id: "run-aaaaaa-1", cursor: 5, open: false, record: mockOf("run-aaaaaa-1") }], real: [] }, heads: [], records: [], ...init };
  const find = (runId) => { const list = st.runs[st.source]; return runId ? list.find((r) => r.id === runId) : list.at(-1); };
  const handle = (url) => {
    const u = new URL(url, "http://x");
    const runId = u.searchParams.get("runId") || undefined;
    const run = find(runId);
    if (u.pathname === "/api/run-observability/head") {
      st.heads.push(url);
      return json({ source: st.source, ...(run ? { runId: run.id, cursor: run.cursor, open: run.open } : { runId: null }) });
    }
    if (u.pathname === "/api/run-observability") {
      st.records.push(url);
      if (st.gate) return st.gate.then(() => json({ source: st.source, record: run?.record ?? null, open: run?.open ?? false, noReply: run?.noReply ?? [], ...(run ? {} : { message: runId ? "No run with that id in this mode." : "No run yet: pick a scenario and press Run." }) }));
      return json({ source: st.source, record: run?.record ?? null, open: run?.open ?? false, noReply: run?.noReply ?? [], ...(run ? {} : { message: runId ? "No run with that id in this mode." : "No run yet: pick a scenario and press Run." }) });
    }
    return undefined;
  };
  return { st, handle };
}
const install = (fake) => { globalThis.fetch = vi.fn((url) => fake.handle(url) ?? json({ error: "not_found" }, 404)); };
const POLL = 20; // the head is polled this often in these tests (2 s on the page)
const tick = async (n = 1) => { await act(async () => { await new Promise((r) => setTimeout(r, POLL * 2 * n)); }); };
const Obs = (props) => <RunObs pollMs={POLL} {...props} />;

beforeEach(() => setJsonView("raw"));
afterEach(() => { vi.restoreAllMocks(); });

test("Mock: the record of the run is shown with the stub's lane note, and it is read once, not on every poll", async () => {
  const fake = fakeRuns(); install(fake);
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  expect(screen.getByTestId("ro-loading")).toHaveTextContent("Collecting this run's logs…");
  expect(await screen.findByTestId("run-observability")).toBeInTheDocument();
  expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Simulated/);
  expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/stub in one process.*Under Privilege is this lab's own policy engine, a stand-in for Privilege.*Under Agent gateway is the stub gateway.*does not call PingOne Authorize/s);
  expect(screen.getByTestId("ro-streams")).toHaveTextContent(/nowhere today: the family log collector's source list does not include this lab's container/);
  expect(fake.st.heads[0]).toBe("/api/run-observability/head?runId=run-aaaaaa-1");
  expect(fake.st.records).toEqual(["/api/run-observability?runId=run-aaaaaa-1"]);
  await tick(4);
  expect(fake.st.heads.length).toBeGreaterThanOrEqual(5);
  expect(fake.st.records.length).toBe(1);
});

test("a new row in the run (the head's cursor moves) reads the record again; a run that closes does too; nothing else does", async () => {
  const fake = fakeRuns(); install(fake);
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  await screen.findByTestId("run-observability");
  const run = fake.st.runs.mock[0];
  run.cursor = 7; run.open = true;
  await waitFor(() => expect(fake.st.records.length).toBe(2));
  expect(await screen.findByTestId("ro-open")).toHaveTextContent(/still waiting for a human/);
  run.open = false;
  await waitFor(() => expect(fake.st.records.length).toBe(3));
  await waitFor(() => expect(screen.queryByTestId("ro-open")).toBeNull());
});

test("the record of a different run is never shown while the new one is being read", async () => {
  const fake = fakeRuns();
  fake.st.runs.mock.push({ id: "run-aaaaaa-2", cursor: 3, open: false, record: { ...mockOf("run-aaaaaa-2"), rows: mockOf("run-aaaaaa-2").rows.slice(0, 2) } });
  install(fake);
  const { rerender } = render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  await screen.findByTestId("run-observability");
  expect(screen.getByTestId("run-observability")).toHaveTextContent(/run-aaaaaa-1/);
  let release; fake.st.gate = new Promise((r) => { release = r; });
  rerender(<Obs runId="run-aaaaaa-2" attempt={null} />);
  expect(await screen.findByTestId("ro-loading")).toBeInTheDocument();
  expect(screen.queryByTestId("run-observability")).toBeNull();
  expect(screen.queryByText(/run-aaaaaa-1/)).toBeNull();
  await act(async () => { release(); });
  expect(await screen.findByTestId("run-observability")).toHaveTextContent(/run-aaaaaa-2/);
});

test("an attempt that began no run says so, asks the server for nothing and does not show the older record", async () => {
  const fake = fakeRuns(); install(fake);
  render(<Obs runId={null} attempt="A scenario is already running. Try again in a moment." />);
  expect(screen.getByTestId("ro-no-run")).toHaveTextContent("That attempt began no run, so there is nothing to show for it: A scenario is already running. Try again in a moment. The record of an earlier run is not shown here.");
  await tick(3);
  expect(screen.queryByTestId("run-observability")).toBeNull();
  expect(fake.st.heads).toEqual([]);
  expect(fake.st.records).toEqual([]);
});

test("a run the server does not know in its mode shows the server's reason, not another run's record", async () => {
  const fake = fakeRuns(); install(fake);
  render(<Obs runId="run-gone-9" attempt={null} />);
  expect(await screen.findByTestId("ro-empty")).toBeInTheDocument();
  expect(screen.getByTestId("ro-none")).toHaveTextContent("No run with that id in this mode.");
  expect(screen.queryByTestId("ro-table")).toBeNull();
  expect(fake.st.records).toEqual(["/api/run-observability?runId=run-gone-9"]);
});

test("Real: the page drops its Mock run id, shows the newest gateway check as response rows, and says what Real is here", async () => {
  const fake = fakeRuns({ source: "real" });
  fake.st.runs.real.push({ id: "check-bbbbbb-2", cursor: 2, open: false, record: realOf("check-bbbbbb-2"), noReply: ["the refusal probe got no reply (the call did not complete), so nothing is shown for it"] });
  install(fake);
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  expect(await screen.findByTestId("run-observability")).toHaveTextContent(/check-bbbbbb-2/);
  expect(screen.getByTestId("ro-basis")).toHaveTextContent(/^Real:/);
  expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/one gateway check.*response row.*reads no gateway log.*nothing is marked logged.*Scenarios always run through the in-process stub/s);
  expect(screen.getByTestId("ro-no-reply")).toHaveTextContent(/the refusal probe got no reply/);
  const table = screen.getByTestId("ro-table");
  expect(within(table).getAllByText("response").length).toBe(2);
  expect(within(table).queryByText("logged")).toBeNull();
  // The first head carried the Mock id (the page does not know the mode yet); once the server said Real it was dropped.
  await tick(2);
  expect(fake.st.heads.at(-1)).toBe("/api/run-observability/head");
  expect(fake.st.records.at(-1)).toBe("/api/run-observability?runId=check-bbbbbb-2");
});

test("a failure to reach the server is an alert, never an empty panel", async () => {
  globalThis.fetch = vi.fn(() => json({ error: "server_error" }, 500));
  render(<Obs runId={null} attempt={null} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/The run's logs could not be collected\. server_error/);
  expect(screen.queryByTestId("ro-table")).toBeNull();
  // a record the server cannot build (a structured JSON error) is shown the same way
  cleanup();
  const fake = fakeRuns();
  globalThis.fetch = vi.fn((url) => (url.startsWith("/api/run-observability?") ? json({ error: "bad_layer", message: "Layer x is listed twice." }, 400) : fake.handle(url)));
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  expect((await screen.findAllByRole("alert")).some((a) => /Layer x is listed twice/.test(a.textContent))).toBe(true);
});

// ---- on the page ----------------------------------------------------------------------------------------------------------------------

function fakePage() {
  const runs = fakeRuns({ runs: { mock: [], real: [] } });
  const state = { calls: [], requests: [] };
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || "GET";
    state.requests.push({ url, method });
    const r = runs.handle(url);
    if (r) return r;
    if (url === "/api/health") return json({ schema: "demo-health/1", state: "ready" });
    if (url === "/api/info") return json({ mode: "mock", source: "mock", requested: "mock", modes: ["mock", "live"], live: { available: false }, realAvailable: false, realReason: "x" });
    if (url === "/api/scenarios") return json({ scenarios: [{ id: "benign", title: "Benign call", description: "d1", agent: "support-bot", steps: 1 }] });
    if (url.startsWith("/api/calls?")) return json({ calls: state.calls, cursor: 1, epoch: 1 });
    if (url === "/api/audit?limit=500") return json({ entries: [entry(1)], size: 1, headSeq: 1 });
    const d = url.match(/^\/api\/diagrams\/([a-z-]+)$/);
    if (d) return json(DIAGRAM_DOCS[d[1]]);
    if (url === "/api/reset") { state.calls = []; runs.st.runs.mock = []; return json({ ok: true }); }
    let m = url.match(/^\/api\/scenarios\/([^/]+)\/run$/);
    if (m) {
      const c = call();
      state.calls = [c];
      runs.st.runs.mock.push({ id: "run-cccccc-1", cursor: 5, open: false, record: mockOf("run-cccccc-1") });
      return json({ mode: "mock", scenario: { id: "benign", title: "Benign call" }, held: false, calls: [c], matched: true, runId: "run-cccccc-1" });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)$/);
    if (m) return json({ call: state.calls.find((c) => c.id === m[1]) });
    return json({ error: "not_found" }, 404);
  });
  return { runs, state };
}
const names = (req) => req.filter((r) => r.url.startsWith("/api/run-observability")).map((r) => r.url);

test("on the page: empty before a run, then the run this page started is asked for by id, and Reset empties it again", async () => {
  const api = fakePage();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  expect(await screen.findByTestId("ro-none")).toHaveTextContent("No run yet: pick a scenario and press Run.");
  expect(screen.getByTestId("run-obs")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await within(screen.getByTestId("run-obs")).findByTestId("run-observability")).toHaveTextContent(/run-cccccc-1/);
  expect(names(api.state.requests)).toContain("/api/run-observability/head?runId=run-cccccc-1");
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(await screen.findByTestId("ro-none")).toHaveTextContent("No run yet");
  expect(screen.queryByText(/run-cccccc-1/)).toBeNull();
});

test("on the page: a run attempt that fails shows that it began no run, never the previous run's record", async () => {
  const ok = fakePage();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await within(screen.getByTestId("run-obs")).findByTestId("run-observability");
  const before = names(ok.state.requests).length;
  // the next attempt is refused (429)
  const real = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init = {}) => ((init.method === "POST" && /\/run$/.test(url)) ? json({ error: "scenario_queue_full", message: "busy" }, 429) : real(url, init)));
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByTestId("ro-no-run")).toHaveTextContent(/That attempt began no run.*A scenario is already running.*not shown here/s);
  expect(screen.queryByText(/run-cccccc-1/)).toBeNull();
  expect(names(ok.state.requests).length).toBe(before); // nothing is asked while an attempt began no run
});
