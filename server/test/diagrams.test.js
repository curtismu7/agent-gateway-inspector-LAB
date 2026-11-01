// The gateway flow diagram is diagram-studio/1 data: validated when the server starts, served by name from an allow-list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, startHttpServer } from '../src/app.js';
import { DEFAULT_DIAGRAMS_DIR, DIAGRAM_NAMES, diagramByName, extensionProblems, loadDiagrams } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { allPassed, runChecks } from '../src/doctor.js';
import { freeBase, request } from './helpers.js';

const readFile = (name, dir = DEFAULT_DIAGRAMS_DIR) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));

// A temp copy of the two files, with `change(name, doc)` applied before writing. Returns the folder.
function tempDir(t, change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-diagrams-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of DIAGRAM_NAMES) {
    const doc = readFile(name);
    const out = change(name, doc);
    fs.writeFileSync(path.join(dir, `${name}.json`), typeof out === 'string' ? out : JSON.stringify(out ?? doc));
  }
  return dir;
}

async function boot(t, diagramsDir) {
  const [port] = [await freeBase('spare', 1)];
  const server = createApp({ runtime: null, diagramsDir }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return port;
}

test('the two diagram files are valid diagram-studio/1 and the loader accepts them', () => {
  for (const name of DIAGRAM_NAMES) {
    const doc = readFile(name);
    assert.equal(doc.schema, 'diagram-studio/1');
    assert.deepEqual(validateDiagram(doc), [], name);
    assert.deepEqual(extensionProblems(doc), [], name);
    assert.equal(doc.nodes.length, 7);
    assert.equal(doc.edges.length, 7);
    assert.equal(doc.steps.length, 6);
  }
  const docs = loadDiagrams();
  assert.deepEqual(Object.keys(docs).sort(), [...DIAGRAM_NAMES].sort());
  assert.ok(Object.isFrozen(docs));
});

test('GET /api/diagrams/:name serves each file as it is on disk, as JSON, not cached', async (t) => {
  const port = await boot(t);
  for (const name of DIAGRAM_NAMES) {
    const r = await request(port, 'GET', `/api/diagrams/${name}`);
    assert.equal(r.status, 200, name);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(r.json, readFile(name));
    assert.deepEqual(validateDiagram(r.json), []);
  }
});

test('the wide and narrow files are one diagram: same boxes, arrows, groups and steps; different positions, and a two-column narrow layout', () => {
  const wide = readFile('gateway-flow'); const narrow = readFile('gateway-flow-narrow');
  assert.deepEqual(wide.nodes.map((n) => [n.id, n.label, n.sub, n.group]), narrow.nodes.map((n) => [n.id, n.label, n.sub, n.group]));
  assert.deepEqual(wide.edges.map((e) => [e.source, e.target, e.label]), narrow.edges.map((e) => [e.source, e.target, e.label]));
  assert.deepEqual(wide.steps, narrow.steps);
  assert.notDeepEqual(wide.nodes.map((n) => [n.x, n.y]), narrow.nodes.map((n) => [n.x, n.y]));
  assert.equal(new Set(narrow.nodes.map((n) => n.x)).size, 2, 'two columns');
  assert.equal(new Set(wide.nodes.map((n) => n.x)).size > 2, true);
});

test('every step lights known boxes, uses valid arrows, and the six steps carry the six story ids in order', () => {
  const d = readFile('gateway-flow');
  assert.deepEqual(d.steps.map((s) => s.story.id), ['S01', 'S06', 'S02', 'S03', 'S04', 'S05']);
  const edgeEnds = new Set(d.nodes.map((n) => n.id));
  for (const s of d.steps) {
    assert.ok(s.nodes.every((n) => edgeEnds.has(n)));
    for (const i of s.edges) { const e = d.edges[i]; assert.ok(s.nodes.includes(e.source) && s.nodes.includes(e.target), `step ${s.title} lights both ends of its arrows`); }
  }
});

test('an unknown name is a JSON 404 that does not repeat what was asked for', async (t) => {
  const port = await boot(t);
  const marker = 'zq9secretmarker';
  const names = [marker, 'nope', 'GATEWAY-FLOW', 'gateway-flow.json', 'gateway-flow-', 'gateway-flow-wide', '..', '%2e%2e%2fpackage', '..%2f..%2fpackage.json', `gateway-flow%00${marker}`, `gateway-flow/${marker}`, 'a'.repeat(300), `${marker}-${'b'.repeat(80)}`, '%00'];
  for (const n of names) {
    const r = await request(port, 'GET', `/api/diagrams/${n}`);
    assert.equal(r.status, 404, n);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.deepEqual(Object.keys(r.json ?? {}).sort(), ['error', 'message'], n);
    assert.ok(!r.raw.includes(marker) && !r.raw.includes('aaaa') && !r.raw.includes('bbbb'), `${n} was echoed`);
  }
  const malformed = await request(port, 'GET', `/api/diagrams/%E0%A4%A${marker}`); // bad percent-encoding is the app's existing 400, also without an echo
  assert.equal(malformed.status, 400);
  assert.ok(!malformed.raw.includes(marker));
  assert.equal((await request(port, 'GET', '/api/diagrams/')).status, 404);
  assert.equal((await request(port, 'GET', '/api/diagrams')).status, 404);
});

test('__proto__, constructor, prototype and the other Object.prototype names are not diagram names', async (t) => {
  const port = await boot(t);
  const docs = loadDiagrams();
  for (const n of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__', '__lookupGetter__', 'toLocaleString']) {
    const r = await request(port, 'GET', `/api/diagrams/${n}`);
    assert.equal(r.status, 404, n);
    assert.equal(r.json.error, 'not_found');
    assert.equal(diagramByName(docs, n), null, n);
  }
  for (const v of [undefined, null, 7, {}, [], ['gateway-flow'], { toString: () => 'gateway-flow' }]) assert.equal(diagramByName(docs, v), null);
  assert.equal(Object.getPrototypeOf(docs), null, 'the loaded set has no prototype to find names on');
  assert.equal(diagramByName(docs, 'gateway-flow').id, 'gateway-flow');
  // a query string or a header cannot pick a file either
  assert.equal((await request(port, 'GET', '/api/diagrams/nope?name=gateway-flow')).status, 404);
});

test('only GET reads a diagram: POST, PUT and DELETE are not routes', async (t) => {
  const port = await boot(t);
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await request(port, m, '/api/diagrams/gateway-flow', { body: {}, headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 404, m);
  }
});

test('a bad diagram file stops the server from starting: nothing is served, and the error names the file and the reason', async (t) => {
  const cases = {
    'wrong schema': (n, d) => (n === 'gateway-flow' ? { ...d, schema: 'diagram-studio/2' } : d),
    'not JSON': (n, d) => (n === 'gateway-flow' ? '{ nope' : d),
    'empty file': (n, d) => (n === 'gateway-flow' ? '' : d),
    'a step names an unknown box': (n, d) => { if (n === 'gateway-flow') d.steps[2].nodes = ['ghost']; return d; },
    'an arrow names an unknown box': (n, d) => { if (n === 'gateway-flow') d.edges[0].target = 'ghost'; return d; },
    'an arrow has no ports': (n, d) => { if (n === 'gateway-flow') delete d.edges[1].ports; return d; },
    'an arrow has a port that is not a side': (n, d) => { if (n === 'gateway-flow') d.edges[1].ports = ['r', 'zz']; return d; },
    'two arrows between the same boxes': (n, d) => { if (n === 'gateway-flow') d.edges.push({ ...d.edges[0] }); return d; },
    'a step lights nothing': (n, d) => { if (n === 'gateway-flow-narrow') d.steps[0].nodes = []; return d; },
    'a step points past the arrows': (n, d) => { if (n === 'gateway-flow') d.steps[0].edges = [99]; return d; },
    'a box has no position': (n, d) => { if (n === 'gateway-flow-narrow') delete d.nodes[0].x; return d; },
    'a box uses an unknown group': (n, d) => { if (n === 'gateway-flow') d.nodes[0].group = 'nope'; return d; },
    'no steps': (n, d) => { if (n === 'gateway-flow') delete d.steps; return d; },
    'the file carries the other name': (n, d) => (n === 'gateway-flow' ? { ...d, id: 'gateway-flow-narrow' } : d),
    'the narrow file has other text': (n, d) => { if (n === 'gateway-flow-narrow') d.nodes[3].label = 'Something else'; return d; },
    'the narrow file has another step': (n, d) => { if (n === 'gateway-flow-narrow') d.steps[4].what = 'Different words'; return d; },
  };
  for (const [label, change] of Object.entries(cases)) {
    const dir = tempDir(t, change);
    assert.throws(() => loadDiagrams(dir), /diagram|narrow/, label);
    assert.throws(() => createApp({ runtime: null, diagramsDir: dir }), /diagram|narrow/, label);
    await assert.rejects(startHttpServer({ port: await freeBase('spare', 1), runtime: { close: async () => {} }, diagramsDir: dir, env: {} }), /diagram|narrow/, label);
  }
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'agi-empty-'));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  assert.throws(() => loadDiagrams(missing), /gateway-flow cannot be read/);
  // the reason is in the message
  const dir = tempDir(t, (n, d) => { if (n === 'gateway-flow') d.edges[1].ports = ['r', 'zz']; return d; });
  assert.throws(() => loadDiagrams(dir), /gateway-flow is not valid diagram-studio\/1: .*ports/);
});

test('a missing diagrams folder refuses startHttpServer before it opens a port or starts the stub upstreams', async () => {
  const port = await freeBase('spare', 1);
  await assert.rejects(startHttpServer({ port, diagramsDir: path.join(os.tmpdir(), 'agi-no-such-folder'), env: {} }), /cannot be read/);
});

test('the doctor reports the diagrams as loaded', () => {
  const c = runChecks({ env: {} }).find((x) => x.id === 'diagrams');
  assert.equal(c.level, 'pass');
  assert.match(c.detail, /2 diagram-studio\/1 files/);
});

test('the doctor fails the diagrams check for a bad file or a missing folder, and the other checks still run', (t) => {
  const bad = tempDir(t, (name, doc) => (name === 'gateway-flow' ? { ...doc, schema: 'diagram-studio/2' } : doc));
  for (const dir of [bad, path.join(os.tmpdir(), 'agi-no-such-folder')]) {
    const checks = runChecks({ env: {}, diagramsDir: dir });
    const c = checks.find((x) => x.id === 'diagrams');
    assert.equal(c.level, 'fail', dir);
    assert.ok(c.detail.length > 0);
    assert.equal(checks.find((x) => x.id === 'node').level, 'pass');
    assert.equal(allPassed(checks), false);
  }
});

test('the server module is the only place the files are read: the web app has no copy of the boxes', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const src = fs.readFileSync(path.join(root, 'web/src/components/Flow.jsx'), 'utf8');
  assert.match(src, /getDiagram\(DIAGRAM_NAMES/);
  assert.doesNotMatch(src, /\bNODES\b|\bEDGES\b|\bLAYOUTS\b|position: \{ x: \d|"e-(call|pass|allow|pause|approve|record|audit)"/);
});
