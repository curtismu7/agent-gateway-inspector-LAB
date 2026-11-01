// The gateway flow diagram is diagram-studio/1 DATA (server/diagrams/*.json), checked at startup with the studio's own validator copy
// and served by name. Nothing in the web app builds nodes or edges by hand.
//
// Two files, one diagram: gateway-flow (wide) and gateway-flow-narrow (the two-column arrangement the page uses under 600px).
// They must describe the same boxes, arrows and steps; only the positions and the ports differ.
//
// diagram-studio/1 has no field for two things this diagram needs, so the files carry two small extensions, checked here
// (the studio's validator ignores unknown keys):
//   edge.ports  [sourcePort, targetPort]: the box side an arrow leaves and enters, so an arrow routes the same way after a move
//   step.nodes  the boxes a step lights (a step can light a box with no arrow, e.g. "the gateway decides")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDiagram } from './diagramStudioValidate.js';

export const DEFAULT_DIAGRAMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../diagrams');
// The only names that can be asked for. A request is matched against this list, never used to build a path.
export const DIAGRAM_NAMES = Object.freeze(['gateway-flow', 'gateway-flow-narrow']);
export const NAME_RE = /^[a-z0-9-]{1,40}$/;
export const PORTS = Object.freeze(['l', 'lout', 'rin', 'r', 'tin', 'bin', 'tout', 'bout']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Problems with the two extensions and with the structure this app relies on. Empty means fine.
export function extensionProblems(d) {
  const p = [];
  const ids = new Set((d.nodes || []).map((n) => n.id));
  const pairs = new Set();
  (d.edges || []).forEach((e, i) => {
    const at = `edge ${i + 1}`;
    if (!Array.isArray(e.ports) || e.ports.length !== 2 || !e.ports.every((x) => PORTS.includes(x))) p.push(`${at}: ports must be [source port, target port], each one of ${PORTS.join(', ')}`);
    const key = `${e.source}>${e.target}`;
    if (pairs.has(key)) p.push(`${at}: a second arrow from ${e.source} to ${e.target}`);
    pairs.add(key);
  });
  (d.steps || []).forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!Array.isArray(s.nodes) || !s.nodes.length || !s.nodes.every((x) => typeof x === 'string' && ids.has(x))) p.push(`${at}: nodes must list known boxes`);
  });
  if (!(d.steps || []).length) p.push('the diagram needs steps');
  return p;
}

// Both layouts must agree on everything except positions and ports.
function sameDiagram(a, b) {
  const shape = (d) => JSON.stringify({
    nodes: d.nodes.map((n) => [n.id, n.label, n.group, n.sub]),
    edges: d.edges.map((e) => [e.source, e.target, e.label]),
    steps: d.steps,
    groups: d.groups,
    title: d.title.replace(/ \(narrow layout.*$/, ''),
  });
  return shape(a) === shape(b);
}

// Read, parse and validate every file. Throws with the reason on the first bad file: the server refuses to start with a bad diagram.
// dir is only ever the app's own folder (or a test's temp folder); names come from DIAGRAM_NAMES, never from a request.
export function loadDiagrams(dir = DEFAULT_DIAGRAMS_DIR) {
  const docs = Object.create(null);
  for (const name of DIAGRAM_NAMES) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')); } catch (e) { throw new Error(`diagram ${name} cannot be read as JSON (${e.code || 'parse error'})`); }
    const problems = [...validateDiagram(doc), ...(isObj(doc) && Array.isArray(doc.nodes) && Array.isArray(doc.edges) && Array.isArray(doc.steps) ? extensionProblems(doc) : [])];
    if (doc?.id !== name) problems.push(`id must be "${name}"`);
    if (problems.length) throw new Error(`diagram ${name} is not valid diagram-studio/1: ${problems.join('; ')}`);
    docs[name] = Object.freeze(doc);
  }
  if (!sameDiagram(docs[DIAGRAM_NAMES[0]], docs[DIAGRAM_NAMES[1]])) throw new Error('the wide and narrow diagrams must have the same boxes, arrows, groups and steps');
  return Object.freeze(docs);
}

// A request name -> a loaded diagram, or null. Own keys of the loaded set only: __proto__, constructor and friends are not names.
export function diagramByName(docs, name) {
  return typeof name === 'string' && NAME_RE.test(name) && DIAGRAM_NAMES.includes(name) && Object.hasOwn(docs, name) ? docs[name] : null;
}
