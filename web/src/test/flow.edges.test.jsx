import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { call, DIAGRAM_DOCS } from "./fixtures.js";

// jsdom cannot measure boxes, so the real React Flow draws no arrows in tests. Here React Flow is replaced by a stub that records the
// nodes and edges it is handed, to prove the arrows are the fetched data's arrows (ids, ends, labels, ports) and nothing else.
let seen;
vi.mock("@xyflow/react", async (orig) => {
  const real = await orig();
  return { ...real, ReactFlow: (props) => { seen = props; return <div data-testid="rf" />; }, Background: () => null, Controls: () => null };
});
const { default: Flow } = await import("../components/Flow.jsx");

function serve(docs) {
  globalThis.fetch = vi.fn((url) => {
    const name = String(url).replace("/api/diagrams/", "");
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(docs[name]) });
  });
}
afterEach(() => { vi.restoreAllMocks(); seen = undefined; });

test("React Flow is handed exactly the arrows of the fetched file, with their labels and ports", async () => {
  const wide = structuredClone(DIAGRAM_DOCS["gateway-flow"]);
  wide.edges.push({ source: "buffer", target: "audit", label: "from the data", ports: ["r", "l"] });
  serve({ "gateway-flow": wide, "gateway-flow-narrow": DIAGRAM_DOCS["gateway-flow-narrow"] });
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={vi.fn()} />);
  await screen.findByTestId("rf");
  expect(seen.edges).toHaveLength(8);
  expect(seen.edges.map((e) => [e.id, e.source, e.target, e.label])).toEqual(wide.edges.map((e) => [`${e.source}>${e.target}`, e.source, e.target, e.label]));
  expect(seen.edges.map((e) => [e.sourceHandle, e.targetHandle])).toEqual(wide.edges.map((e) => e.ports));
  expect(seen.nodes.map((n) => [n.id, n.position.x, n.position.y])).toEqual(wide.nodes.map((n) => [n.id, n.x, n.y]));
});

test("a step lights the arrows its data names and only those the run used", async () => {
  serve(DIAGRAM_DOCS);
  const onSimulate = vi.fn().mockResolvedValue({ calls: [call()], auditSize: 3 });
  render(<Flow run={null} auditSize={0} callCount={0} theme="light" onSimulate={onSimulate} />);
  await screen.findByTestId("rf");
  await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
  await screen.findByText(/Step 1 of 6/);
  expect(seen.edges.filter((e) => e.animated).map((e) => e.id)).toEqual(["agent>layers"]);
  expect(seen.edges.filter((e) => e.className === "edge-on")).toHaveLength(1);
});

const posOf = (id) => { const n = seen.nodes.find((x) => x.id === id); return [n.position.x, n.position.y]; };

test("a moved box stays where it was put, and Reset diagram and the page Reset both put it back at the data's position", async () => {
  serve(DIAGRAM_DOCS);
  const props = { run: null, auditSize: 0, callCount: 0, theme: "light", onSimulate: vi.fn() };
  const { rerender } = render(<Flow {...props} resetSignal={0} />);
  await screen.findByTestId("rf");
  const home = DIAGRAM_DOCS["gateway-flow"].nodes.find((n) => n.id === "gateway");
  expect(posOf("gateway")).toEqual([home.x, home.y]);
  act(() => seen.onNodesChange([{ type: "position", id: "gateway", position: { x: 5, y: 7 }, dragging: false }]));
  expect(posOf("gateway")).toEqual([5, 7]);
  await userEvent.click(screen.getByRole("button", { name: "Reset diagram" }));
  expect(posOf("gateway")).toEqual([home.x, home.y]);
  act(() => seen.onNodesChange([{ type: "position", id: "gateway", position: { x: 9, y: 9 }, dragging: false }]));
  expect(posOf("gateway")).toEqual([9, 9]);
  rerender(<Flow {...props} resetSignal={1} />);
  await waitFor(() => expect(posOf("gateway")).toEqual([home.x, home.y]));
});
