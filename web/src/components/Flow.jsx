import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getDiagram } from "../lib/api.js";
import { normalizeDiagram } from "../lib/diagram.js";
import { STORY } from "./Story.jsx";

// agent -> scope layers -> gateway policy -> upstream tool, with the human approver, the decision buffer and the audit trail.
// The boxes, arrows, positions and the six steps are diagram-studio/1 DATA served by the server (GET /api/diagrams/:name, rule 17);
// this component draws whatever it is given and builds no node or edge itself.
// Boxes are draggable. Simulate runs the selected scenario for real, then walks six steps that say in words what
// that run did, using its real numbers. The scope layers box is a Ping release claim (2026-11-02), UNVERIFIED on our tenant.
// Two files: wide (one row of steps) and narrow (two columns, under the 600px breakpoint) so the text stays readable on a phone.
export const DIAGRAM_NAMES = { wide: "gateway-flow", narrow: "gateway-flow-narrow" };
// Put every box back where this diagram starts it. Existing nodes keep their measured size, so React Flow does not re-measure
// or re-fit the view (a Reset that rebuilt the nodes made the view jump now and then).
const placeAll = (prev, diagram) => prev.map((n) => {
  const d = diagram.nodes.find((x) => x.id === n.id);
  return d ? { ...n, position: { x: d.x, y: d.y } } : n;
});
const toNodes = (diagram) => diagram.nodes.map((n) => ({ id: n.id, position: { x: n.x, y: n.y }, data: { title: n.title, sub: n.sub } }));
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];
const BASE_MS = 1700;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const LAYER_NAME = { surface: "surface", application: "application", action: "action", endUser: "end user" };
const failedLayer = (c) => Object.entries(c.layers || {}).find(([, v]) => v === "fail")?.[0];

function useNarrow() {
  const q = "(max-width: 599px)";
  const read = () => { try { return window.matchMedia(q).matches; } catch { return false; } };
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    let m;
    try { m = window.matchMedia(q); } catch { return undefined; }
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

// Which arrows this run really used. The diagram data says what each step COULD light; the run says what it did. An arrow not listed is used.
function usedArrows({ passedLayers, allow, pause, approvedForward }) {
  return { "layers>gateway": passedLayers.length > 0, "gateway>upstream": allow.length > 0, "gateway>human": pause.length > 0, "human>upstream": approvedForward };
}
// A step's boxes and arrows from the data, cut down to what the run used: an unused arrow is not lit, and neither is a box only that arrow reaches.
function lit(step, used) {
  const on = (k) => used[k] ?? true;
  const edges = step.edges.filter(on);
  const reached = new Set(step.edges.filter(on).map((k) => k.split(">")[1]));
  const missed = new Set(step.edges.filter((k) => !on(k)).map((k) => k.split(">")[1]));
  return { nodes: step.nodes.filter((id) => !missed.has(id) || reached.has(id)), edges };
}

// Sim steps built from one real run and the diagram's own steps. Without a run the captions say so and carry no numbers.
export function buildSteps(run, auditSize = 0, diagram) {
  const calls = run?.calls || [];
  if (!calls.length || !diagram) return [];
  const n = calls.length;
  const by = (d) => calls.filter((c) => c.decision === d);
  const allow = by("allow"); const deny = by("deny"); const pause = by("pause");
  const forwarded = calls.filter((c) => c.outcome === "forwarded");
  const tools = [...new Set(calls.map((c) => c.tool))].join(", ");
  const reasons = [...new Set(deny.map((c) => c.reason))].join(", ");
  const refusedByLayer = calls.filter((c) => failedLayer(c));
  const passedLayers = calls.filter((c) => c.layers && !failedLayer(c) && Object.values(c.layers).every((v) => v === "pass"));
  const atLayers = [...new Set(refusedByLayer.map((c) => LAYER_NAME[failedLayer(c)]))].join(", ");
  const layerText = !passedLayers.length && !refusedByLayer.length ? "The call was stopped before the token was read."
    : `${plural(passedLayers.length, "call")} passed all four scope checks${refusedByLayer.length ? `; ${plural(refusedByLayer.length, "call")} refused at the ${atLayers} layer, before any rule was read` : ""}. (Ping release claim, unverified.)`;
  const attended = pause.filter((c) => !c.hold);
  const unattended = pause.filter((c) => c.hold);
  const retried = calls.filter((c) => c.reason === "hold_approved");
  const replays = calls.filter((c) => c.reason === "approval_consumed");
  const changed = calls.filter((c) => c.reason === "approval_mismatch");
  const attendedText = !attended.length ? ""
    : attended.every((c) => c.outcome === "pending") ? `${plural(attended.length, "call")} held and waiting for a human. Answer it in the Inspector tab.`
    : attended.some((c) => c.outcome === "forwarded") ? "The held call was approved with the one-shot code and then forwarded."
    : attended.some((c) => c.outcome === "expired") ? "The held call expired before anyone answered, so it was never forwarded."
    : "The held call was denied by the human, so it was never forwarded.";
  const unattendedText = !unattended.length ? ""
    : `${plural(unattended.length, "unattended call")} refused at once with a reference and an expiry, no connection kept open.${retried.length ? ` A human approved the reference and the agent's exact retry was allowed once.` : " Approve it in the Inspector tab, then press the retry button."}${changed.length ? " A retry with a changed argument was refused: the approval is bound to the exact call." : ""}${replays.length ? " A replay of the spent approval was refused." : ""}`;
  const holdText = [attendedText, unattendedText].filter(Boolean).join(" ") || "No call needed a human.";
  const approvedForward = attended.some((c) => c.outcome === "forwarded") || retried.length > 0;
  const used = usedArrows({ passedLayers, allow, pause, approvedForward });
  const texts = [
    `${calls[0].agentId} sends ${plural(n, "tool call")}: ${tools}.`,
    layerText,
    `The gateway decides: ${allow.length} allow, ${deny.length} deny, ${pause.length} hold for a human${reasons ? `. Denied because: ${reasons}` : ""}.`,
    allow.length ? `${plural(allow.length, "allowed call")} reached the upstream tool; ${plural(forwarded.length, "call")} in total were forwarded. ${deny.length ? `${plural(deny.length, "denied call")} never reached it.` : ""}` : "Nothing was allowed, so nothing reached an upstream tool.",
    holdText,
    `${n === 1 ? "The call is" : `All ${n} calls are`} in the decision buffer, and every decision and answer was appended to the audit trail (${auditSize} entr${auditSize === 1 ? "y" : "ies"} now).`,
  ];
  // The step's story link in the data (S01...) picks the story-strip item it highlights.
  const storyAt = (st, i) => { const at = STORY.findIndex((x) => x.id === st.story?.id); return at < 0 ? i : at; };
  return diagram.steps.map((st, i) => ({ ...lit(st, used), story: storyAt(st, i), text: texts[i] ?? st.what }));
}

function Box({ data }) {
  return (
    <div className={`fbox${data.narrow ? " fbox--narrow" : ""}`} data-on={data.on ? "true" : undefined} data-dim={data.dim ? "true" : undefined}>
      <Handle className="fbox__handle" id="l" type="target" position={Position.Left} />
      <Handle className="fbox__handle" id="lout" type="source" position={Position.Left} />
      <Handle className="fbox__handle" id="rin" type="target" position={Position.Right} />
      <Handle className="fbox__handle" id="r" type="source" position={Position.Right} />
      <Handle className="fbox__handle" id="tin" type="target" position={Position.Top} />
      <Handle className="fbox__handle" id="bin" type="target" position={Position.Bottom} />
      <Handle className="fbox__handle fbox__handle--tout" id="tout" type="source" position={Position.Top} />
      <Handle className="fbox__handle" id="bout" type="source" position={Position.Bottom} />
      <strong>{data.title}</strong>
      <span>{data.sub}</span>
      {data.count !== undefined && <b className="fbox__count">{data.count}</b>}
    </div>
  );
}
const nodeTypes = { box: Box };

// Both layouts are fetched by name once. null while loading, { error } if either cannot be had.
function useDiagrams() {
  const [docs, setDocs] = useState(null);
  useEffect(() => {
    let live = true; // a late answer after the component has gone is dropped
    Promise.all([getDiagram(DIAGRAM_NAMES.wide), getDiagram(DIAGRAM_NAMES.narrow)]).then(
      ([wide, narrow]) => { if (live) setDocs({ wide: normalizeDiagram(wide), narrow: normalizeDiagram(narrow) }); },
      (e) => { if (live) setDocs({ error: e.message }); },
    );
    return () => { live = false; };
  }, []);
  return docs;
}

export default function Flow({ run, auditSize, callCount, scenarioTitle, theme, busy, onSimulate, onStep, resetSignal = 0 }) {
  const narrow = useNarrow();
  const layout = narrow ? "narrow" : "wide";
  const docs = useDiagrams();
  const diagram = docs && !docs.error ? docs[layout] : null;
  const [moved, setMoved] = useState(null);
  const [speed, setSpeed] = useState("1");
  const [step, setStep] = useState(-1);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState([]);

  useEffect(() => {
    if (!running) return undefined;
    if (step >= steps.length - 1) { setRunning(false); return undefined; }
    const t = setTimeout(() => setStep((s) => s + 1), BASE_MS / Number(speed));
    return () => clearTimeout(t);
  }, [running, step, steps.length, speed]);
  useEffect(() => { onStep?.(step >= 0 && steps[step] ? steps[step].story : -1); }, [step, steps, onStep]);
  // A different diagram (first load, or a different width and so a different arrangement) puts every box where that diagram starts it.
  useEffect(() => { if (diagram) setMoved(toNodes(diagram)); }, [diagram]);

  const simulate = async () => {
    setRunning(false); setStep(-1);
    const result = await onSimulate();
    if (!result || !diagram) return;
    const s = buildSteps(result, result.auditSize, diagram);
    setSteps(s); setStep(0); setRunning(true);
  };
  const rf = useRef(null);
  const fit = () => rf.current?.fitView({ padding: narrow ? 0.03 : 0.1 });
  // Reset also re-fits the view: boxes back where they started AND the same view of them every time.
  const reset = () => { setRunning(false); setStep(-1); setSteps([]); if (diagram) setMoved((n) => (n ? placeAll(n, diagram) : n)); setTimeout(fit, 0); };
  // The page-level Reset bumps resetSignal: the boxes go back too (rule 3). Not on the first render.
  const lastSignal = useRef(resetSignal);
  useEffect(() => { if (lastSignal.current !== resetSignal) { lastSignal.current = resetSignal; reset(); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const onNodesChange = useCallback((c) => setMoved((n) => (n ? applyNodeChanges(c, n) : n)), []);

  const cur = step >= 0 ? steps[step] : null;
  const counts = useMemo(() => {
    const calls = run?.calls;
    if (!calls?.length) return { buffer: callCount, audit: auditSize };
    return {
      agent: calls.length, gateway: calls.length,
      upstream: calls.filter((c) => c.outcome === "forwarded").length,
      human: calls.filter((c) => c.decision === "pause").length,
      buffer: callCount, audit: auditSize,
    };
  }, [run, callCount, auditSize]);
  const nodes = useMemo(() => (moved || []).map((n) => ({
    ...n, type: "box", ariaLabel: `${n.data.title}: ${n.data.sub}${counts[n.id] !== undefined ? `, ${counts[n.id]}` : ""}. Arrow keys move the box.`,
    data: { ...n.data, narrow, count: counts[n.id], on: !!cur?.nodes.includes(n.id), dim: !!cur && !cur.nodes.includes(n.id) },
  })), [moved, cur, counts, narrow]);
  const edges = useMemo(() => (diagram?.edges || []).map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label, sourceHandle: e.ports[0], targetHandle: e.ports[1],
    animated: !!cur?.edges.includes(e.id), className: cur?.edges.includes(e.id) ? "edge-on" : "", markerEnd: { type: MarkerType.ArrowClosed },
  })), [cur, diagram]);

  return (
    <>
      <div className="card controls">
        <label>Speed
          <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
            {SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </label>
        <button type="button" className="primary" onClick={simulate} disabled={busy || running || !diagram}>Simulate</button>
        <button type="button" className="btn" onClick={reset}>Reset diagram</button>
        <span className="muted small">Simulate runs the selected scenario ({scenarioTitle || "none"}) for real, then walks through what happened. Drag any box.</span>
      </div>
      <div className="flow-wrap" role="group" aria-label="Gateway flow: agent, four scope layers, gateway policy, upstream tool, human approver, decision buffer and audit trail. Boxes can be dragged.">
        {docs?.error ? <p className="alert" role="alert">Could not load the diagram ({docs.error}).</p>
          : !diagram || !moved ? <p className="muted small" role="status">Loading the diagram...</p>
            : (
              <ReactFlow key={layout} onInit={(i) => { rf.current = i; }} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} colorMode={theme}
                fitView fitViewOptions={{ padding: narrow ? 0.03 : 0.1 }} nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.2}>
                <Background />
                <Controls showInteractive={false} position={narrow ? "top-right" : "bottom-left"} />
              </ReactFlow>
            )}
      </div>
      <p className="caption" role="status" aria-live="polite" data-testid="caption">
        {cur ? `Step ${step + 1} of ${steps.length}: ${cur.text}` : "Press Simulate to run the selected scenario and walk through it step by step."}
      </p>
    </>
  );
}
