import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import Flow, { buildSteps } from "../components/Flow.jsx";
import { call, paused, DIAGRAM_DOCS, WIDE } from "./fixtures.js";

test("buildSteps is empty without a run", () => {
  expect(buildSteps(null, 0, WIDE)).toEqual([]);
  expect(buildSteps({ calls: [] }, 0, WIDE)).toEqual([]);
});

test("buildSteps uses the numbers of the real run", () => {
  const run = { calls: [call(), call({ id: "call-0002", decision: "deny", outcome: "blocked", reason: "rate_limited", ruleId: null })] };
  const steps = buildSteps(run, 9, WIDE);
  expect(steps).toHaveLength(6);
  expect(steps[0].text).toMatch(/2 tool calls/);
  expect(steps[2].text).toMatch(/1 allow, 1 deny, 0 hold for a human/);
  expect(steps[2].text).toMatch(/rate_limited/);
  expect(steps[3].edges).toEqual(["gateway>upstream"]);
  expect(steps[4].text).toMatch(/No call needed a human/);
  expect(steps[5].text).toMatch(/9 entries/);
});

test("buildSteps follows a paused call to its outcome", () => {
  const approved = buildSteps({ calls: [paused({ outcome: "forwarded" })] }, 0, WIDE)[4];
  expect(approved.text).toMatch(/approved/);
  expect(approved.edges).toEqual(["gateway>human", "human>upstream"]);
  expect(buildSteps({ calls: [paused({ outcome: "expired" })] }, 0, WIDE)[4].text).toMatch(/expired/);
  expect(buildSteps({ calls: [paused({ outcome: "pending" })] }, 0, WIDE)[4].text).toMatch(/waiting for a human/);
  const denied = buildSteps({ calls: [call({ decision: "deny", outcome: "blocked" })] }, 0, WIDE);
  expect(denied[3].text).toMatch(/Nothing was allowed/);
  expect(denied[3].edges).toEqual([]);
});

test("buildSteps lights only the boxes and arrows the run used, from the boxes and arrows the data lists for each step", () => {
  const nodes = (run) => buildSteps(run, 0, WIDE).map((st) => st.nodes);
  const layersOk = { surface: "pass", application: "pass", action: "pass", endUser: "pass" };
  // allowed, no layer data: the gateway is not lit at step 2 (nothing passed), the upstream is lit at step 4, nobody is held
  expect(nodes({ calls: [call()] })).toEqual([["agent", "layers"], ["layers"], ["gateway"], ["gateway", "upstream"], ["gateway"], ["gateway", "buffer", "audit"]]);
  // the same call with all four layers passed lights the gateway at step 2 too
  expect(nodes({ calls: [call({ layers: layersOk })] })[1]).toEqual(["layers", "gateway"]);
  // a denied call reaches nothing upstream
  expect(nodes({ calls: [call({ decision: "deny", outcome: "blocked" })] })[3]).toEqual(["gateway"]);
  // a held call reaches the human; the upstream only after an approval
  expect(nodes({ calls: [paused({ outcome: "pending" })] })[4]).toEqual(["gateway", "human"]);
  expect(nodes({ calls: [paused({ outcome: "forwarded" })] })[4]).toEqual(["gateway", "human", "upstream"]);
  expect(buildSteps({ calls: [paused({ outcome: "pending" })] }, 0, WIDE)[4].edges).toEqual(["gateway>human"]);
  expect(buildSteps({ calls: [call()] }, 0, WIDE).map((st) => st.story)).toEqual([0, 1, 2, 3, 4, 5]);
});

test("a step's story link in the data picks the story-strip item it highlights", () => {
  const swapped = { ...WIDE, steps: WIDE.steps.map((st, i) => (i === 0 ? { ...st, story: { id: "S05", step: 1 } } : st)) };
  expect(buildSteps({ calls: [call()] }, 0, swapped).map((st) => st.story)).toEqual([5, 1, 2, 3, 4, 5]);
});

// The Flow component fetches its diagram by name. This serves the real diagram-studio/1 files, or the ones a test hands it.
function serveDiagrams(docs = DIAGRAM_DOCS) {
  const requested = [];
  globalThis.fetch = vi.fn((url) => {
    requested.push(url);
    const name = String(url).replace("/api/diagrams/", "");
    const body = Object.hasOwn(docs, name) ? docs[name] : { error: "not_found", message: "no such diagram" };
    return Promise.resolve({ ok: Object.hasOwn(docs, name), status: Object.hasOwn(docs, name) ? 200 : 404, json: () => Promise.resolve(body) });
  });
  return requested;
}
const transformOf = (title) => [...document.querySelectorAll(".react-flow__node")].find((n) => n.textContent.startsWith(title))?.style.transform;
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

test("the diagram renders seven boxes and the controls, and Simulate asks for a real run", async () => {
  const requested = serveDiagrams();
  const run = { calls: [call()], auditSize: 3 };
  const onSimulate = vi.fn().mockResolvedValue(run);
  render(<Flow run={null} auditSize={0} callCount={0} scenarioTitle="Benign call" theme="light" onSimulate={onSimulate} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(7));
  expect(requested.sort()).toEqual(["/api/diagrams/gateway-flow", "/api/diagrams/gateway-flow-narrow"]);
  for (const t of ["Agent", "Four scope layers", "Gateway policy", "Upstream tool", "Human approver", "Decision buffer", "Audit trail"]) expect(screen.getByText(t)).toBeInTheDocument();
  expect(screen.getByLabelText("Speed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reset diagram" })).toBeInTheDocument();
  screen.getByRole("button", { name: "Simulate" }).click();
  expect(onSimulate).toHaveBeenCalledTimes(1);
  expect(await screen.findByTestId("caption", {}, { timeout: 2000 })).toHaveTextContent(/Step 1 of 6: support-bot sends 1 tool call/);
});

test("the boxes and arrows come from the fetched data, not from the component: other data draws other boxes, in their places", async () => {
  const wide = structuredClone(DIAGRAM_DOCS["gateway-flow"]);
  wide.nodes[0].label = "Planner bot";
  wide.nodes[0].x = 40;
  wide.nodes.push({ id: "extra", label: "Extra box", group: "record", sub: ["from the data"], x: 1200, y: 330 });
  wide.edges.push({ source: "gateway", target: "extra", label: "extra arrow", ports: ["bout", "tin"] });
  serveDiagrams({ "gateway-flow": wide, "gateway-flow-narrow": DIAGRAM_DOCS["gateway-flow-narrow"] });
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(8));
  expect(screen.getByText("Planner bot")).toBeInTheDocument();
  expect(screen.queryByText("Agent")).toBeNull();
  expect(screen.getByText("Extra box")).toBeInTheDocument();
  expect(transformOf("Planner bot")).toBe("translate(40px,110px)");
  expect(transformOf("Extra box")).toBe("translate(1200px,330px)");
}); // (jsdom does not measure boxes, so React Flow draws no arrows here: flow.edges.test.jsx checks the arrows passed to it)

test("under 600px the narrow file is the one drawn: the same boxes in the two-column arrangement", async () => {
  serveDiagrams();
  const mm = vi.spyOn(window, "matchMedia").mockImplementation((q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(7));
  expect(transformOf("Four scope layers")).toBe("translate(0px,120px)");
  expect(transformOf("Audit trail")).toBe("translate(220px,120px)");
  expect(document.querySelector(".fbox--narrow")).not.toBeNull();
  mm.mockRestore();
});

test("on a wide screen the wide file is drawn", async () => {
  serveDiagrams();
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(7));
  expect(transformOf("Four scope layers")).toBe("translate(300px,110px)");
  expect(transformOf("Human approver")).toBe("translate(900px,220px)");
});

test("if the diagram cannot be fetched the page says so, draws nothing, and Simulate stays off", async () => {
  serveDiagrams({});
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load the diagram \(no such diagram\)/);
  expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Simulate" })).toBeDisabled();
});

test("while the diagram is loading Simulate is off, then it turns on", async () => {
  serveDiagrams();
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Simulate" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
});

test("a simulated run lights the boxes of the step and dims the rest, from the step data; Reset diagram clears it", async () => {
  serveDiagrams();
  const onSimulate = vi.fn().mockResolvedValue({ calls: [call()], auditSize: 3 });
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={onSimulate} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
  await screen.findByText(/Step 1 of 6/);
  const on = () => [...document.querySelectorAll(".fbox[data-on='true']")].map((n) => n.querySelector("strong").textContent);
  expect(on()).toEqual(["Agent", "Four scope layers"]);
  expect(document.querySelectorAll(".fbox[data-dim='true']")).toHaveLength(5);
  await userEvent.click(screen.getByRole("button", { name: "Reset diagram" }));
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
  expect(document.querySelectorAll(".fbox[data-on='true']")).toHaveLength(0);
});

test("a failed run leaves the diagram idle", async () => {
  serveDiagrams();
  const onSimulate = vi.fn().mockResolvedValue(null);
  render(<Flow run={null} auditSize={0} callCount={0} theme="dark" onSimulate={onSimulate} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  screen.getByRole("button", { name: "Simulate" }).click();
  await Promise.resolve();
  expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/);
});

test("every diagram box has an accessible name that says what it is", async () => {
  serveDiagrams();
  render(<Flow run={{ calls: [call()] }} auditSize={3} callCount={1} scenarioTitle="Benign call" theme="light" busy={false} onSimulate={() => {}} onStep={() => {}} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(7));
  const names = [...document.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("aria-label"));
  expect(names.every(Boolean)).toBe(true);
  expect(names.some((n) => /^Gateway policy: deny by default/.test(n))).toBe(true);
  expect(names.some((n) => /^Audit trail: .*3/.test(n))).toBe(true);
});

test("the page-level Reset (resetSignal) puts the diagram back to idle, as the Reset diagram button does", async () => {
  serveDiagrams();
  const onSimulate = vi.fn().mockResolvedValue({ calls: [call()], auditSize: 3 });
  const props = { run: null, auditSize: 0, callCount: 0, scenarioTitle: "Benign call", theme: "light", onSimulate };
  const { rerender } = render(<Flow {...props} resetSignal={0} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  screen.getByRole("button", { name: "Simulate" }).click();
  expect(await screen.findByTestId("caption", {}, { timeout: 2000 })).toHaveTextContent(/Step 1 of 6/);
  rerender(<Flow {...props} resetSignal={1} />);
  await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent(/Press Simulate/));
});

test("Speed sets the time each step is shown: 1700 ms at 1x, a quarter of it at 4x, double at 0.5x", async () => {
  serveDiagrams();
  const stepDelays = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...rest) => { if (ms >= 100) stepDelays.push(ms); return realSetTimeout(fn, ms, ...rest); });
  const onSimulate = vi.fn().mockResolvedValue({ calls: [call()], auditSize: 3 });
  render(<Flow run={null} auditSize={0} callCount={0} scenarioTitle="Benign call" theme="light" onSimulate={onSimulate} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  const delayAt = async (speed) => {
    stepDelays.length = 0;
    await userEvent.selectOptions(screen.getByLabelText("Speed"), speed);
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    await screen.findByText(/Step 1 of 6/);
    const d = [...stepDelays]; // the test library sets timers of its own, so look for the step timer among them
    await userEvent.click(screen.getByRole("button", { name: "Reset diagram" }));
    return d;
  };
  expect(await delayAt("1")).toContain(1700);
  const fast = await delayAt("4");
  expect(fast).toContain(425);
  expect(fast).not.toContain(1700);
  const slow = await delayAt("0.5");
  expect(slow).toContain(3400);
  expect(slow).not.toContain(1700);
});
