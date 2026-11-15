import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import { call, paused, entry, DIAGRAM_DOCS } from "./fixtures.js";
import { mockTrace } from "../../../server/src/gatewayTrace.js";
import { setJsonView } from "../components/JsonPane.jsx";

// The trace the stub gateway builds for an allowed call: every decision `checked` (the lab computed it), the tool server answer `observed`.
const allowTrace = () => mockTrace({
  url: "https://agent-gateway.invalid/mcp", authorization: "Bearer tok-support",
  rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tickets.read", arguments: { ticketId: "T-100" } } },
  status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }], isError: false } },
  decisions: [
    { id: "agent", label: "Agent registered", outcome: "pass", evidence: "support-bot is a registered agent" },
    { id: "rules", label: "Rules", outcome: "pass", evidence: "rule allow-ticket-read allows this call" },
    { id: "forward", label: "Tool server", outcome: "pass", basis: "observed", evidence: "the stub tool server answered" },
  ],
  record: 'Audit entry "decision" for call-0001: allow, rule_allow.',
});

function fakeApi({ withTrace = true } = {}) {
  const state = { calls: [], requests: [] };
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || "GET";
    state.requests.push({ url, method });
    if (url === "/api/health") return json({ schema: "demo-health/1", state: "ready" });
    if (url === "/api/info") return json({ mode: "mock", source: "mock", requested: "mock", modes: ["mock", "live"], live: { available: false }, realAvailable: false, realReason: "x" });
    if (url === "/api/scenarios") return json({ scenarios: [{ id: "benign", title: "Benign call", description: "d1", agent: "support-bot", steps: 1 }, { id: "paused-approved", title: "Paused, then approved", description: "d2", agent: "finance-agent", steps: 1 }] });
    if (url.startsWith("/api/calls?")) return json({ calls: state.calls, cursor: 1, epoch: 1 });
    if (url === "/api/audit?limit=500") return json({ entries: [entry(1)], size: 1, headSeq: 1 });
    const d = url.match(/^\/api\/diagrams\/([a-z-]+)$/);
    if (d) return json(DIAGRAM_DOCS[d[1]]);
    if (url === "/api/reset") { state.calls = []; return json({ ok: true }); }
    let m = url.match(/^\/api\/scenarios\/([^/]+)\/run$/);
    if (m) {
      const c = m[1] === "benign" ? call(withTrace ? { trace: allowTrace() } : {}) : paused({ trace: null });
      state.calls = [c];
      return json({ mode: "mock", scenario: { id: m[1], title: m[1] === "benign" ? "Benign call" : "Paused, then approved" }, held: m[1] !== "benign", calls: [c], matched: m[1] === "benign" ? true : null });
    }
    if (/^\/api\/calls\/call-\d+\/decision$/.test(url)) {
      state.calls = [paused({ outcome: "forwarded", pause: { state: "approved", ttlMs: 1, expiresAt: new Date().toISOString() }, trace: allowTrace() })];
      return json({ call: state.calls[0] });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)$/);
    if (m) return json({ call: state.calls.find((c) => c.id === m[1]) });
    return json({ error: "not_found" }, 404);
  });
  return state;
}

beforeEach(() => setJsonView("raw"));
afterEach(() => { vi.restoreAllMocks(); });

test("the Run page has the What Privilege did panel, empty until Run", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  expect(screen.getByRole("heading", { name: "What Privilege did" })).toBeInTheDocument();
  expect(screen.getByTestId("gateway-trace-empty")).toBeInTheDocument();
  expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent(/Simulated/);
});

test("Run shows the exchange under the result: the request, the response and the decisions the stub computed, none called inferred", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  const ex = await screen.findByTestId("trace-1");
  expect(ex).toHaveTextContent("call-0001: tools/call tickets.read");
  expect(ex).toHaveTextContent("all 3 decisions passed");
  expect(screen.getByTestId("trace-1-request-head").textContent).toContain("POST https://agent-gateway.invalid/mcp");
  expect(screen.getByTestId("trace-1-response-body").textContent).toContain('"isError": false');
  expect(screen.queryByText("inferred from the outcome")).toBeNull();
  expect(screen.getByText("observed in the response")).toBeInTheDocument();
  expect(screen.queryByTestId("gateway-trace-empty")).toBeNull();
});

test("a call that is waiting for a human is named, not drawn; its exchange appears once it is answered", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.selectOptions(screen.getByLabelText("Scenario"), "paused-approved");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByTestId("trace-waiting")).toHaveTextContent("call-0002 is waiting");
  expect(screen.queryByTestId("trace-1")).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Approve and forward" }));
  expect(await screen.findByTestId("trace-1")).toHaveTextContent("call-0002: tools/call payments.transfer");
  await waitFor(() => expect(screen.queryByTestId("trace-waiting")).toBeNull());
});

test("a reply without a trace (an older server) leaves the panel empty and nothing breaks", async () => {
  fakeApi({ withTrace: false });
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText(/Ran "Benign call"/);
  expect(screen.getByTestId("gateway-trace-empty")).toBeInTheDocument();
});
