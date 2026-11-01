// A diagram-studio/1 document (served by GET /api/diagrams/:name, already validated by the server) -> what the Flow component draws.
// Nothing here knows which boxes or arrows exist: it only reshapes the data. An arrow is named "source>target".
export const edgeKey = (e) => `${e.source}>${e.target}`;

export function normalizeDiagram(doc) {
  const nodes = doc.nodes.map((n) => ({ id: n.id, title: n.label, sub: (n.sub || []).join(" "), group: n.group, x: n.x, y: n.y }));
  const edges = doc.edges.map((e) => ({ id: edgeKey(e), source: e.source, target: e.target, label: e.label, ports: e.ports }));
  const steps = doc.steps.map((s) => ({ title: s.title, what: s.what, nodes: s.nodes, edges: s.edges.map((i) => edges[i].id), story: s.story }));
  return { id: doc.id, title: doc.title, nodes, edges, steps };
}
