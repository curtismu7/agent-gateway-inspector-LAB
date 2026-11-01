// Ping release claim (2026-11-02), UNVERIFIED on our tenant: the banner on every tab, the four scope checks, the hold panel,
// the exact-call approval and the retry, as the UI shows them. The server behaviour itself is tested in server/test.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";
import CallDetail from "../components/CallDetail.jsx";
import { buildSteps } from "../components/Flow.jsx";
import { STORY } from "../components/Story.jsx";
import { held, refused, call, DIAGRAM_DOCS, WIDE, NARROW } from "./fixtures.js";

function fakeApi(opts = {}) {
  const state = { calls: [], requests: [], hold: "pending", ...opts };
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || "GET";
    state.requests.push({ url, method, init });
    if (url === "/api/health") return json({ schema: "demo-health/1", state: "ready" });
    if (url === "/api/info") return json({ mode: "mock", requested: "mock", modes: ["mock", "live"], live: { available: false, failed: ["live-gateway"], needs: ["x"] } });
    if (url === "/api/scenarios") return json({ scenarios: [{ id: "hold-unattended", title: "Unattended hold, approved, retried once", description: "d", agent: "finance-agent", steps: 2 }] });
    if (url.startsWith("/api/calls?")) return json({ calls: state.calls, cursor: 1, epoch: 1 });
    if (url === "/api/audit?limit=500") return json({ entries: [], size: 0, headSeq: 0 });
    const d = url.match(/^\/api\/diagrams\/([a-z-]+)$/);
    if (d) return DIAGRAM_DOCS[d[1]] ? json(DIAGRAM_DOCS[d[1]]) : json({ error: "not_found" }, 404);
    let m = url.match(/^\/api\/scenarios\/([^/]+)\/run$/);
    if (m) { state.calls = [held("pending")]; return json({ mode: "mock", scenario: { id: m[1], title: "Unattended hold, approved, retried once" }, held: true, calls: state.calls, matched: null }); }
    m = url.match(/^\/api\/calls\/(call-\d+)\/decision$/);
    if (m) { state.decided = JSON.parse(init.body); state.hold = "approved"; state.calls = [held("approved")]; return json({ call: state.calls[0] }); }
    m = url.match(/^\/api\/calls\/(call-\d+)\/retry$/);
    if (m) {
      const first = state.hold === "approved";
      state.hold = "consumed";
      state.calls = [held("consumed"), call({ id: "call-0004", decision: first ? "allow" : "deny", outcome: first ? "forwarded" : "blocked", reason: first ? "hold_approved" : "approval_consumed" })];
      return json({ call: state.calls[1] });
    }
    m = url.match(/^\/api\/calls\/(call-\d+)$/);
    if (m) return json({ call: state.calls.find((c) => c.id === m[1]) });
    return json({ error: "not_found" }, 404);
  });
  return state;
}
afterEach(() => { vi.restoreAllMocks(); });

const BANNER = /Ping release claim \(2026-11-02\), UNVERIFIED on our tenant\./;

test("the release claim banner is on the Inspector tab and the Diagram tab, says the mode and that there is no live path, and is there once", async () => {
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: /Unattended hold/ });
  const banner = screen.getByTestId("release-banner");
  expect(screen.getByRole("region", { name: "Release claim notice" })).toBe(banner);
  expect(banner).toHaveTextContent(BANNER);
  expect(banner).toHaveTextContent(/Live is refused: there is no live gateway, so there is no live path until the release is on our tenant/);
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  expect(screen.getByRole("region", { name: "Release claim notice" })).toHaveTextContent(BANNER);
  expect(screen.getAllByTestId("release-banner")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Inspector" }));
  expect(screen.getByTestId("release-banner")).toBeInTheDocument();
});

test("the banner stays when the API is unreachable, and in presenter mode", async () => {
  globalThis.fetch = vi.fn(() => Promise.reject(new Error("down")));
  const first = render(<App />);
  expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
  expect(screen.getByTestId("release-banner")).toHaveTextContent(BANNER);
  expect(screen.getByTestId("release-banner")).toHaveTextContent(/^Mock mode\./);
  first.unmount();
  fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: /Unattended hold/ });
  await userEvent.keyboard("p");
  expect(screen.getByTestId("release-banner")).toHaveTextContent(BANNER);
  await userEvent.click(screen.getByRole("button", { name: "Diagram" }));
  expect(screen.getByTestId("release-banner")).toBeInTheDocument();
});

test("the four scope checks show in order, each with a word and a glyph; the first refusal is marked and the rest are not reached", () => {
  const { rerender } = render(<CallDetail call={refused("application", "scope_application")} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  const items = () => within(screen.getByTestId("scope-strip")).getAllByRole("listitem");
  expect(items().map((li) => li.getAttribute("data-layer"))).toEqual(["surface", "application", "action", "endUser"]);
  expect(items().map((li) => li.getAttribute("data-state"))).toEqual(["pass", "fail", "skipped", "skipped"]);
  expect(items().map((li) => li.textContent)).toEqual(["1. Surface✓ Passed", "2. Application✕ Refused", "3. Action– Not reached", "4. End user– Not reached"]);
  expect(screen.getByTestId("scope-strip")).toHaveTextContent(/Ping release claim, UNVERIFIED on our tenant/);
  expect(screen.getByText(/Layer 2, application/)).toBeInTheDocument();
  rerender(<CallDetail call={refused("endUser", "scope_end_user")} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  expect(items().map((li) => li.getAttribute("data-state"))).toEqual(["pass", "pass", "pass", "fail"]);
  rerender(<CallDetail call={held("pending")} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  expect(items().map((li) => li.getAttribute("data-state"))).toEqual(["pass", "pass", "pass", "pass"]);
  // negative control: a call from an older server with no layer data shows no strip at all
  rerender(<CallDetail call={call()} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  expect(screen.queryByTestId("scope-strip")).toBeNull();
});

test("the token claims are shown as inert text, with the attended claim in words", () => {
  const c = refused("surface", "scope_surface", { claims: { subject: "tok-x", application: "<b>app</b>", surface: "llm​", endUser: "user-manager", attended: false } });
  render(<CallDetail call={c} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  const strip = screen.getByTestId("scope-strip");
  expect(strip).toHaveTextContent("<b>app</b>");
  expect(strip.querySelector("b")).toBeNull();
  expect(strip).toHaveTextContent(/unattended, the gateway refuses at once with a reference and an expiry/);
});

test("a hold is approved from the UI with its own code in the JSON body, forwards nothing, and the code is never shown", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: /Unattended hold/ });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  const approve = await screen.findByRole("button", { name: "Approve this exact call" });
  await waitFor(() => expect(approve).toBeEnabled());
  const hold = screen.getByTestId("hold");
  expect(hold).toHaveTextContent("hold-0123456789abcdef");
  expect(hold).toHaveTextContent(/hash of agent, tool, token and every argument/);
  expect(document.body.textContent).not.toContain("hold-code-1");
  await userEvent.click(approve);
  await screen.findByText(/Approved call-0003: nothing was forwarded\. The agent can now retry the exact call once\./);
  expect(api.decided).toEqual({ decision: "approve", approvalCode: "hold-code-1" });
  const post = api.requests.find((r) => r.url === "/api/calls/call-0003/decision");
  expect(post.init.credentials).toBe("omit");
  expect(post.init.headers).not.toHaveProperty("Authorization");
  expect(document.body.textContent).not.toContain("hold-code-1");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve this exact call" })).toBeNull());
  expect(screen.getByTestId("hold")).toHaveTextContent(/Approved: waiting for the agent's exact retry \(works once\)/);
});

test("the agent's retry is allowed once and the replay is refused: the retry button posts no body, and the message says what happened", async () => {
  const api = fakeApi();
  render(<App />);
  await screen.findByRole("option", { name: /Unattended hold/ });
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  const approve = await screen.findByRole("button", { name: "Approve this exact call" });
  await waitFor(() => expect(approve).toBeEnabled());
  await userEvent.click(approve);
  const retry = await screen.findByRole("button", { name: "Agent retries the exact call" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await screen.findByText(/The agent retried call-0003 as call-0004: Allow, hold_approved\./);
  const post = api.requests.find((r) => r.url === "/api/calls/call-0003/retry");
  expect(post.method).toBe("POST");
  expect(post.init.body).toBeUndefined();
  const replay = await screen.findByRole("button", { name: "Replay the same approval" });
  await waitFor(() => expect(replay).toBeEnabled());
  await userEvent.click(replay);
  await screen.findByText(/The agent retried call-0003 as call-0004: Deny, approval_consumed\. That approval was already used once\. A second replay is refused\./);
  expect(api.requests.filter((r) => r.url.endsWith("/retry"))).toHaveLength(2);
});

test("a spent, expired or denied hold offers no approve button; only a live one does", () => {
  const props = { headingRef: null, busy: false, onDecide: () => {}, onRetry: () => {} };
  const { rerender } = render(<CallDetail call={held("consumed")} {...props} />);
  expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  expect(screen.getByTestId("hold")).toHaveTextContent(/Spent: the retry used it/);
  expect(screen.getByTestId("hold")).toHaveTextContent("call-0004");
  for (const [state, outcome] of [["expired", "expired"], ["denied", "denied_by_human"], ["locked", "blocked"]]) {
    rerender(<CallDetail call={held(state, { outcome })} {...props} />);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /retries|Replay/ })).toBeNull();
  }
  rerender(<CallDetail call={held("pending")} {...props} />);
  expect(screen.getByRole("button", { name: "Approve this exact call" })).toBeEnabled();
});

test("the swagger tags are on screen: reuse of console names is labelled schema only, and the layers and hold outcome are labelled lab-invented", () => {
  render(<CallDetail call={held("pending")} headingRef={null} busy={false} onDecide={() => {}} onRetry={() => {}} />);
  const names = screen.getByText("Where these field names come from").closest("details");
  expect(names).toHaveTextContent(/Console swagger name, 2026-10-31, schema only/);
  for (const n of ["RequestID", "FieldHash", "ExpiresAt", "GrantTTLSec", "ConsumedAt", "ConsumedByRequestID", "DeniedBy", "ExpiredAt", "DecidedAt"]) expect(names).toHaveTextContent(n);
  expect(names).toHaveTextContent(/four scope checks, the hold outcome and attended versus unattended have no swagger name: lab-invented/);
  expect(names).not.toHaveTextContent(/RetiredAt|NonHumanIdentity/);
});

test("a busy page disables the new buttons, and they come back when it is idle", () => {
  const props = { headingRef: null, onDecide: () => {}, onRetry: () => {} };
  const { rerender } = render(<CallDetail call={held("pending")} busy {...props} />);
  expect(screen.getByRole("button", { name: "Approve this exact call" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Agent retries the exact call" })).toBeDisabled();
  rerender(<CallDetail call={held("pending")} busy={false} {...props} />);
  expect(screen.getByRole("button", { name: "Approve this exact call" })).toBeEnabled();
});

test("the story strip carries the scope layers and hold steps in walk-through order, and the simulation steps line up with it", () => {
  expect(STORY.map((s) => s.title)).toEqual(["1. Call", "2. Scope layers", "3. Decide", "4. Forward", "5. Hold for a human", "6. Record"]);
  expect(STORY[1].proves).toMatch(/Ping release claim, unverified/);
  const run = { calls: [call({ layers: { surface: "pass", application: "pass", action: "pass", endUser: "pass" } }), refused("surface", "scope_surface")] };
  const steps = buildSteps(run, 4, WIDE);
  expect(steps).toHaveLength(STORY.length);
  expect(steps.map((s) => s.story)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(steps[1].text).toMatch(/1 call passed all four scope checks; 1 call refused at the surface layer, before any rule was read/);
  expect(steps[1].edges).toEqual(["layers>gateway"]);
  expect(buildSteps({ calls: [refused("action", "scope_exceeded")] }, 0, WIDE)[1].edges).toEqual([]);
});

test("the simulation walks an unattended hold: refused at once, then the exact retry once, a changed retry and a replay refused", () => {
  const retried = call({ id: "call-0004", reason: "hold_approved", decision: "allow", outcome: "forwarded" });
  const replay = call({ id: "call-0005", reason: "approval_consumed", decision: "deny", outcome: "blocked" });
  const changed = call({ id: "call-0006", reason: "approval_mismatch", decision: "deny", outcome: "blocked" });
  const text = buildSteps({ calls: [held("consumed"), retried, changed, replay] }, 0, WIDE)[4].text;
  expect(text).toMatch(/1 unattended call refused at once with a reference and an expiry, no connection kept open\./);
  expect(text).toMatch(/exact retry was allowed once/);
  expect(text).toMatch(/changed argument was refused: the approval is bound to the exact call/);
  expect(text).toMatch(/replay of the spent approval was refused/);
  expect(buildSteps({ calls: [held("pending")] }, 0, WIDE)[4].text).toMatch(/Approve it in the Inspector tab, then press the retry button/);
  expect(buildSteps({ calls: [held("consumed"), retried] }, 0, WIDE)[4].edges).toEqual(["gateway>human", "human>upstream"]);
});

test("both diagram files place every box, give every arrow its ports, agree with each other, and never put two boxes on top of each other", () => {
  const BOX_W = 190; const BOX_H = 70;
  expect(NARROW.nodes.map((n) => [n.id, n.title, n.sub])).toEqual(WIDE.nodes.map((n) => [n.id, n.title, n.sub]));
  expect(NARROW.edges.map((e) => [e.id, e.label])).toEqual(WIDE.edges.map((e) => [e.id, e.label]));
  expect(NARROW.steps).toEqual(WIDE.steps);
  for (const [name, d] of Object.entries({ wide: WIDE, narrow: NARROW })) {
    expect(d.nodes).toHaveLength(7); expect(d.edges).toHaveLength(7);
    for (const e of d.edges) expect(e.ports, `${name} ${e.id}`).toHaveLength(2);
    for (let i = 0; i < d.nodes.length; i++) for (let j = i + 1; j < d.nodes.length; j++) {
      const a = d.nodes[i]; const b = d.nodes[j];
      expect(Math.abs(a.x - b.x) >= BOX_W + 20 || Math.abs(a.y - b.y) >= BOX_H + 20, `${name}: ${a.id} and ${b.id}`).toBe(true);
    }
  }
  const phone = Math.max(...NARROW.nodes.map((n) => n.x)) + 170;
  expect(phone).toBeLessThanOrEqual(390);
});
