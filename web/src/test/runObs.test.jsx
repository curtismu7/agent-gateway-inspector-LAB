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
      if (st.rawHead) return st.rawHead();
      const body = () => json({ source: st.source, ...(run ? { runId: run.id, cursor: run.cursor, open: run.open } : { runId: null }) });
      return st.headGate ? st.headGate.then(body) : body();
    }
    if (u.pathname === "/api/run-observability") {
      st.records.push(url);
      if (st.rawRecord) return st.rawRecord();
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

// What the server must never be able to hang the panel with: a 200 whose body is not JSON (an error page, an empty body) or is JSON null. api.js hands these over as null.
const NOT_JSON = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) });
const EMPTY = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")) });
const NULL_BODY = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) });
test.each([
  ["the head answer is an HTML page with status 200", { rawHead: NOT_JSON }],
  ["the head answer is JSON null", { rawHead: NULL_BODY }],
  ["the record answer is an HTML page with status 200", { rawRecord: NOT_JSON }],
  ["the record answer is JSON null", { rawRecord: NULL_BODY }],
  ["the record answer has an empty body", { rawRecord: EMPTY }],
])("an answer that is not a run answer is an alert, never a panel stuck on Collecting: %s", async (_name, shape) => {
  const fake = fakeRuns(); Object.assign(fake.st, shape); install(fake);
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/The run's logs could not be collected\. The server's reply was not what this page expects/);
  expect(screen.queryByTestId("ro-loading")).toBeNull();
  expect(screen.queryByTestId("ro-table")).toBeNull();
  await tick(2); // later polls keep the alert; nothing throws (an unhandled error would fail this test)
  expect(screen.getByRole("alert")).toBeInTheDocument();
  // and the panel recovers when the server answers properly again
  delete fake.st.rawHead; delete fake.st.rawRecord;
  await waitFor(() => expect(screen.getByTestId("ro-table")).toBeInTheDocument(), { timeout: 3000 });
});

test("a new run asked for is never shown as the previous run's record while the head answer is late", async () => {
  const fake = fakeRuns();
  fake.st.runs.mock.push({ id: "run-aaaaaa-2", cursor: 3, open: false, record: mockOf("run-aaaaaa-2") });
  install(fake);
  const { rerender } = render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  await screen.findByTestId("run-observability");
  expect(screen.getByTestId("ro-table")).toHaveTextContent("Mock sign-in in run-aaaaaa-1");
  // The page presses Run: it now asks for run 2, and the server's head answer for it is slow.
  let release; fake.st.headGate = new Promise((r) => { release = r; });
  rerender(<Obs runId="run-aaaaaa-2" attempt={null} />);
  expect(await screen.findByTestId("ro-loading")).toHaveTextContent("Collecting this run's logs…");
  expect(screen.queryByText(/Mock sign-in in run-aaaaaa-1/)).toBeNull();
  expect(screen.queryByTestId("run-observability")).toBeNull();
  await tick(3); // still late: still collecting, still not the old record
  expect(screen.getByTestId("ro-loading")).toBeInTheDocument();
  expect(screen.queryByText(/Mock sign-in in run-aaaaaa-1/)).toBeNull();
  await act(async () => { release(); });
  expect(await screen.findByText(/Mock sign-in in run-aaaaaa-2/)).toBeInTheDocument();
  expect(screen.queryByText(/Mock sign-in in run-aaaaaa-1/)).toBeNull();
  // Reset: the page asks for no run in particular; a late head must not show run 2 either
  fake.st.runs.mock = [];
  fake.st.headGate = new Promise((r) => { release = r; });
  rerender(<Obs runId={null} attempt={null} />);
  expect(await screen.findByTestId("ro-loading")).toBeInTheDocument();
  expect(screen.queryByText(/Mock sign-in in run-aaaaaa-2/)).toBeNull();
  await act(async () => { release(); });
  expect(await screen.findByTestId("ro-none")).toHaveTextContent("No run yet");
});

test("a partial Real check is visibly partial: the lane names the missing probe, the page says so, and the wording does not claim the gateway sent nothing", async () => {
  const fake = fakeRuns({ source: "real" });
  const record = realOf("check-bbbbbb-3");
  record.rows = record.rows.slice(0, 1).concat(record.rows.slice(2));
  record.partial = { gateway: true };
  record.reasons = { ...record.reasons, gateway: "Partial check: the refusal probe got no reply (the lab read it as no connection), so this lane holds the tools/list reply only. Absence of a reply is not proof of what the gateway would have answered." };
  record.summary = { allowed: 1, refused: 0, blocked: 0, info: 0, unverified: 0 };
  fake.st.runs.real.push({ id: "check-bbbbbb-3", cursor: 1, open: false, record, noReply: ["The refusal probe got no reply: the lab read it as no connection (a gateway reply with this exact wording would be read the same way), so nothing is shown for it"] });
  install(fake);
  render(<Obs runId={null} attempt={null} />);
  expect(await screen.findByTestId("ro-reason-gateway")).toHaveTextContent(/^Partial check: the refusal probe got no reply.*not proof/);
  expect(screen.getByTestId("ro-partial")).toHaveTextContent(/Partial check\. The Agent gateway lane above holds only some of this check's replies/);
  expect(screen.getByTestId("ro-no-reply")).toHaveTextContent(/read it as no connection \(a gateway reply with this exact wording would be read the same way\)/);
  expect(screen.getByTestId("ro-no-reply")).not.toHaveTextContent(/sent nothing|did not complete/);
  expect(screen.getByTestId("ro-lane-gateway")).toHaveAttribute("data-coverage", "response");
});

test("the notes under the panel say the counts are check rows, not calls (Mock) and rows per reply (Real)", async () => {
  const fake = fakeRuns(); install(fake);
  render(<Obs runId="run-aaaaaa-1" attempt={null} />);
  expect(await screen.findByTestId("ro-lab-note")).toHaveTextContent(/Counts above are check rows, not calls: one call makes several checks.*gateway row repeats the policy engine's decision as information/s);
  cleanup();
  const real = fakeRuns({ source: "real" });
  real.st.runs.real.push({ id: "check-bbbbbb-2", cursor: 2, open: false, record: realOf("check-bbbbbb-2"), noReply: [] });
  install(real);
  render(<Obs runId={null} attempt={null} />);
  expect(await screen.findByTestId("ro-lab-note")).toHaveTextContent(/Counts above are rows, one per reply the lab received/);
});

// ---- on the page ----------------------------------------------------------------------------------------------------------------------

function fakePage() {
  const runs = fakeRuns({ runs: { mock: [], real: [] } });
  const state = { calls: [], requests: [] };
  const out = { state, runs, next: null };
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
      const id = out.next || "run-cccccc-1";
      runs.st.runs.mock.push({ id, cursor: 5, open: false, record: mockOf(id) });
      return json({ mode: "mock", scenario: { id: "benign", title: "Benign call" }, held: false, calls: [c], matched: true, runId: id });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)$/);
    if (m) return json({ call: state.calls.find((c) => c.id === m[1]) });
    return json({ error: "not_found" }, 404);
  });
  return out;
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

test("on the page: pressing Run on a second scenario never shows the first run's record while the head answer is late", async () => {
  const api = fakePage();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await within(screen.getByTestId("run-obs")).findByTestId("run-observability");
  expect(screen.getByTestId("run-obs")).toHaveTextContent("Mock sign-in in run-cccccc-1");
  let release; api.runs.st.headGate = new Promise((r) => { release = r; });
  api.next = "run-cccccc-2";
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await within(screen.getByTestId("run-obs")).findByTestId("ro-loading")).toBeInTheDocument();
  expect(screen.getByTestId("run-obs")).not.toHaveTextContent("Mock sign-in in run-cccccc-1");
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getByTestId("run-obs")).toHaveTextContent("Mock sign-in in run-cccccc-2"));
  // Reset with a late head: nothing of run 2 is shown meanwhile
  api.runs.st.headGate = new Promise((r) => { release = r; });
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(await within(screen.getByTestId("run-obs")).findByTestId("ro-loading")).toBeInTheDocument();
  expect(screen.getByTestId("run-obs")).not.toHaveTextContent("run-cccccc-2");
  await act(async () => { release(); });
  expect(await screen.findByTestId("ro-none")).toHaveTextContent("No run yet");
});
