import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import { call, paused, entry, DIAGRAM_DOCS } from "./fixtures.js";

// A tiny in-memory fake of the API. It records every request so tests can check what the UI sends.
function fakeApi(opts = {}) {
  const state = { calls: [], audit: [entry(1)], requests: [], verify: { ok: true, length: 1, headSeq: 1, headHash: "ab".repeat(32) }, ...opts };
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || "GET";
    state.requests.push({ url, method, init });
    if (url === "/api/health") return json({ schema: "demo-health/1", state: "ready" });
    if (url === "/api/info") return json({ mode: "mock", requested: state.requested || "mock", modes: ["mock", "live"], live: { available: false, failed: ["owner-opt-in", "live-gateway"], needs: ["x", "y"] } });
    if (url === "/api/scenarios") return json({ scenarios: [{ id: "benign", title: "Benign call", description: "d1", agent: "support-bot", steps: 1 }, { id: "paused-approved", title: "Paused, then approved", description: "d2", agent: "finance-agent", steps: 1 }] });
    if (url.startsWith("/api/calls?")) return json({ calls: state.calls, cursor: 1, epoch: 1 });
    if (url === "/api/audit?limit=500") return json({ entries: state.audit, size: state.audit.length, headSeq: state.audit.length });
    if (url === "/api/audit/verify") return json(state.verify);
    let d = url.match(/^\/api\/diagrams\/([a-z-]+)$/);
    if (d) return DIAGRAM_DOCS[d[1]] ? json(DIAGRAM_DOCS[d[1]]) : json({ error: "not_found" }, 404);
    if (url === "/api/reset") { state.calls = []; return json({ ok: true }); }
    let m = url.match(/^\/api\/scenarios\/([^/]+)\/run$/);
    if (m) {
      const c = m[1] === "benign" ? call() : paused();
      state.calls = [c];
      return json({ mode: "mock", scenario: { id: m[1], title: m[1] === "benign" ? "Benign call" : "Paused, then approved" }, held: m[1] !== "benign", calls: [c], matched: m[1] === "benign" ? true : null });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)\/decision$/);
    if (m) {
      const body = JSON.parse(init.body);
      if (state.decideStatus) return json({ error: state.decideError }, state.decideStatus);
      state.decided = body;
      state.calls = [paused({ outcome: body.decision === "approve" ? "forwarded" : "denied_by_human", pause: { state: "approved", ttlMs: 1, expiresAt: new Date().toISOString() } })];
      return json({ call: state.calls[0] });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)$/);
    if (m) return json({ call: state.calls.find((c) => c.id === m[1]) });
    return json({ error: "not_found" }, 404);
  });
  return state;
}

afterEach(() => { vi.restoreAllMocks(); });

test("the web client has no call for a mode-switch route: the server has none", async () => {
  const api = await import("../lib/api.js");
  expect(Object.keys(api).filter((k) => /mode/i.test(k))).toEqual([]);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/lib/api.js"), "utf8");
  expect(src).not.toMatch(/\/api\/mode/);
});

test("the header Reset reaches the diagram: boxes and caption go back to idle after a simulated run", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled()); // enabled once the diagram data has loaded
  await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
  expect(await screen.findByTestId("caption", {}, { timeout: 3000 })).toHaveTextContent(/Step 1 of 6/);
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/), { timeout: 3000 });
});

test("shows the Mock mode, loads scenarios and starts empty", async () => {
  fakeApi();
  render(<App />);
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
  await screen.findByRole("option", { name: "Benign call" });
  expect(screen.getByText(/No calls yet/)).toBeInTheDocument();
});

test("Run runs the scenario, lists the call with its badge and opens its detail", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText(/Ran "Benign call": 1 call, 1 allow, 0 deny, 0 hold for a human\. Matches the expected result\./);
  const list = await screen.findByRole("list", { name: /Calls/ });
  expect(within(list).getByText("Allow")).toBeInTheDocument();
  expect(await screen.findByTestId("detail")).toHaveTextContent("allow-ticket-read");
  const run = api.requests.find((r) => r.url === "/api/scenarios/benign/run");
  expect(run.method).toBe("POST");
  expect(JSON.parse(run.init.body)).toEqual({ hold: true });
});

test("a paused call is approved from the UI: the code goes in the JSON body, never as a header", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.selectOptions(screen.getByLabelText("Scenario"), "paused-approved");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await userEvent.click(await screen.findByRole("button", { name: "Approve and forward" }));
  await screen.findByText(/Approved call-0002/);
  expect(api.decided).toEqual({ decision: "approve", approvalCode: "demo-code-1" });
  const post = api.requests.find((r) => r.url === "/api/calls/call-0002/decision");
  expect(post.init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
  expect(post.init.credentials).toBe("omit");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve and forward" })).toBeNull());
});

test("a refused answer is shown as an alert in words", async () => {
  fakeApi({ decideStatus: 409, decideError: "expired" });
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.selectOptions(screen.getByLabelText("Scenario"), "paused-approved");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/expired/);
});

test("Verify chain shows a verified result, then a tampered one", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Verify chain" }));
  expect(await screen.findByText(/Chain verified: 1 entry/)).toBeInTheDocument();
  api.verify = { ok: false, length: 4, firstBadSeq: 3, reason: "chain_broken" };
  await userEvent.click(screen.getByRole("button", { name: "Verify chain" }));
  expect(await screen.findByText(/TAMPERED: the chain fails at entry #3/)).toBeInTheDocument();
});

test("Reset clears the list and tells the user", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText(/Ran "Benign call"/);
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  await screen.findByText(/Reset: calls cleared/);
  await waitFor(() => expect(screen.getByText(/No calls yet/)).toBeInTheDocument());
});

test("the theme toggle sets data-theme and every request is same-origin and credential-free", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.selectOptions(screen.getByTestId("theme"), "dark");
  expect(["dark", "light"]).toContain(document.documentElement.dataset.theme);
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await screen.findByText(/Ran "Benign call"/);
  for (const r of api.requests) {
    expect(r.url.startsWith("/api/")).toBe(true);
    expect(JSON.stringify(r.init.headers || {}).toLowerCase()).not.toMatch(/authorization|x-api-key|cookie/);
    expect(r.init.credentials).toBe("omit");
  }
});

test("the Diagram tab shows the flow and the story strip; the Inspector tab is reachable again", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(7));
  expect(screen.getByRole("region", { name: "What each step proves" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Inspector" }));
  expect(screen.getByRole("heading", { name: /Audit trail/ })).toBeInTheDocument();
});

test("an unreachable API is announced", async () => {
  globalThis.fetch = vi.fn(() => Promise.reject(new Error("down")));
  render(<App />);
  expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
});

// GW2 pins.
const runPaused = async () => {
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.selectOptions(screen.getByLabelText("Scenario"), "paused-approved");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
};

test("Deny sends the word deny with the call's code (and Approve sends approve)", async () => {
  const api = fakeApi();
  render(<App />);
  await runPaused();
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  await screen.findByText(/Denied call-0002: it was never forwarded/);
  expect(api.decided).toEqual({ decision: "deny", approvalCode: "demo-code-1" });
  expect(api.requests.filter((r) => r.url.endsWith("/decision"))).toHaveLength(1);
});

test("without an approval code the UI sends nothing and says so", async () => {
  const api = fakeApi();
  const real = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init) => (url === "/api/calls/call-0002"
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ call: paused({ pause: { state: "pending", ttlMs: 1, expiresAt: new Date(Date.now() + 30000).toISOString() } }) }) })
    : real(url, init)));
  render(<App />);
  await runPaused();
  await userEvent.click(await screen.findByRole("button", { name: "Approve and forward" }));
  expect(await screen.findByText("No approval code is available for this call.")).toBeInTheDocument();
  expect(api.requests.some((r) => r.url.endsWith("/decision"))).toBe(false);
});

test("after Approve or Deny, keyboard focus moves to the call detail heading instead of falling to the page", async () => {
  fakeApi();
  render(<App />);
  await runPaused();
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  await screen.findByText(/Denied call-0002/);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Call call-0002/ })));
});

test("the run status does not claim a call is waiting when it has already expired", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init) => (url.endsWith("/run")
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ scenario: { id: "paused-expired", title: "Paused, then expired" }, held: true, matched: null, calls: [paused({ outcome: "expired", pause: { state: "expired", ttlMs: 1, expiresAt: new Date().toISOString() } })] }) })
    : orig(url, init)));
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  const status = await screen.findByTestId("run-status");
  await waitFor(() => expect(status).toHaveTextContent(/Ran "Paused, then expired"/));
  expect(status).not.toHaveTextContent(/waiting for you/);
  expect(status).toHaveTextContent(/no longer waiting: expired/);
  expect(api.requests.length).toBeGreaterThan(0);
});

test("the unreachable-API messages go away once the API answers again", async () => {
  const api = fakeApi();
  let down = true;
  const real = globalThis.fetch;
  globalThis.fetch = vi.fn((url, init) => (down ? Promise.reject(new Error("down")) : real(url, init)));
  render(<App />);
  expect(await screen.findByText(/Could not reach the gateway API: down/)).toBeInTheDocument();
  expect(screen.getByText(/Cannot reach the gateway API/)).toBeInTheDocument();
  down = false;
  await waitFor(() => expect(screen.queryByText(/Could not reach the gateway API/)).toBeNull(), { timeout: 6000 });
  await waitFor(() => expect(screen.queryByText(/Cannot reach the gateway API/)).toBeNull(), { timeout: 6000 });
  expect(api.requests.length).toBeGreaterThan(0);
}, 15000);

test("the header has a Mock/Live toggle that shows the mode, and the banner says the same mode", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("mode-live")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
  expect(screen.getByTestId("release-banner")).toHaveTextContent(/^Mock mode\./);
  expect(screen.getByTestId("release-banner")).toHaveAttribute("data-state", "mock");
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
  expect(screen.getByTestId("release-banner")).toHaveTextContent(/^Mock mode\./);
});

test("Live is refused: the click says why, the page stays in Mock, and no request is made for it", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  const before = api.requests.length;
  await userEvent.click(screen.getByTestId("mode-live"));
  expect(screen.getByTestId("live-note")).toHaveTextContent(/Live is refused: this app has no live gateway/);
  expect(screen.getByTestId("mode-live")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
  expect(screen.getByTestId("release-banner")).toHaveTextContent(/^Mock mode\./);
  expect(api.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);
  await userEvent.click(screen.getByTestId("mode-mock"));
  expect(screen.queryByTestId("live-note")).toBeNull();
});

test("a settings request for live is shown as refused at load, and the page opens in Mock", async () => {
  fakeApi({ requested: "live" });
  render(<App />);
  expect(await screen.findByTestId("live-note")).toHaveTextContent(/GATEWAY_INSPECTOR_MODE=live is set and is refused too/);
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
});

test("presenter mode (P, Esc): the mode and the banner stay, the toggle, Reset and theme go; typing in the picker does not toggle it", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  await userEvent.keyboard("p");
  expect(document.querySelector(".app")).toHaveAttribute("data-presenter", "on");
  expect(screen.getByTestId("mode-badge")).toHaveTextContent("Mode: Mock");
  expect(screen.getByTestId("release-banner")).toBeInTheDocument();
  expect(screen.queryByTestId("mode-live")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  expect(screen.getByTestId("release-banner")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".app")).not.toHaveAttribute("data-presenter");
  expect(screen.getByTestId("mode-live")).toBeInTheDocument();
  document.getElementById("scenario-select").focus();
  await userEvent.keyboard("p");
  expect(document.querySelector(".app")).not.toHaveAttribute("data-presenter");
});

test("no request carries a workspace header: there is one workspace", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: "Benign call" });
  expect(api.requests.every((r) => !("X-Workspace-Id" in (r.init.headers || {})))).toBe(true);
});
