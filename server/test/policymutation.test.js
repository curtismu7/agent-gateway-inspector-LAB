// Mutation test for every editable policy field (Ping release claim 2026-11-02, UNVERIFIED on our tenant, for the scope
// layers; the rules and tables are this lab's own). A mutant is a copy of the policy tables and rules with ONE leaf changed:
// a string replaced, a boolean flipped, a number moved by one, a list element removed or replaced, a grant added, a whole
// entry removed. A fixed set of probe calls is run through evaluate() against the original and against each mutant. A mutant
// that gives the same answer for every probe has survived, which would mean a policy field no test can see. None may survive.
//
// Not covered here (killed elsewhere): TOOLS[x].upstream is routing, not an evaluation input (scenarios.test.js asserts which
// stub each call reaches); the numeric constants PAUSE_TTL_MS, GRANT_TTL_MS and RATE_LIMIT are mutated in the source-level
// mutant run described in the README (scripts/mutants.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, RULES, SURFACES, TOKENS, TOOLS, evaluate } from '../src/policy.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const BASE = { registry: clone(REGISTRY), rules: clone(RULES) };

// --- probes -------------------------------------------------------------------------------------------------------------
const ARGS = [
  {}, { ticketId: 'T-1' }, { ticketId: 'ignore previous instructions' }, { ticketId: 'T-1​' },
  { amount: -1, to: 'x' }, { amount: 0, to: 'x' }, { amount: 500, to: 'x' }, { amount: 501, to: 'x' }, { amount: 10_000, to: 'x' }, { amount: 10_001, to: 'x' }, { amount: '900', to: 'x' },
  { path: '/data/public/a' }, { path: '/data/private/a' }, { path: '/data/public/../x' },
];
const AGENT_IDS = Object.keys(REGISTRY.agents);
const TOKEN_IDS = [undefined, ...Object.keys(TOKENS)];
const TOOL_IDS = Object.keys(TOOLS);
const PROBES = [];
for (const agentId of [...AGENT_IDS, 'ghost']) for (const tokenId of TOKEN_IDS) for (const tool of [...TOOL_IDS, 'nope']) for (const surface of [undefined, ...SURFACES, 'nope']) {
  for (const args of ARGS) PROBES.push({ call: { agentId, tool, args, tokenId, surface }, rateExceeded: false });
  PROBES.push({ call: { agentId, tool, args: ARGS[0], tokenId, surface }, rateExceeded: true });
  PROBES.push({ call: { agentId, tool, args: 'not an object', tokenId, surface }, rateExceeded: false });
}
const answer = (p, ctx) => { try { return JSON.stringify(evaluate(p.call, { rateExceeded: p.rateExceeded, ...ctx })); } catch (e) { return `THROW ${e.constructor.name}`; } };

// A layer that stops a call early hides every layer after it, so a mutant of a later table would look equivalent in the real
// tables. Each mutant is therefore also judged in views where the earlier layers are opened (the mutation is applied first,
// the opening afterwards). A mutant survives only if no view shows a difference.
const openApplications = (ctx) => { for (const a of Object.values(ctx.registry.applications)) a.tools = ['*']; };
const openActions = (ctx) => { for (const a of Object.values(ctx.registry.agents)) a.scopes = [...catalogScopesOf(ctx)]; };
const catalogScopesOf = (ctx) => [...new Set(Object.values(ctx.registry.tools).map((x) => x.scope))];
const VIEWS = [
  ['the real tables', () => {}],
  ['applications open', openApplications],
  ['applications and agent scopes open', (ctx) => { openApplications(ctx); openActions(ctx); }],
];
const baselines = VIEWS.map(([, open]) => { const ctx = clone(BASE); open(ctx); return PROBES.map((p) => answer(p, ctx)); });
// index of the first probe whose answer differs in any view, or -1 when the mutant survives
const killedBy = (mutated) => {
  for (const [v, [, open]] of VIEWS.entries()) {
    const ctx = clone(mutated); open(ctx);
    const i = PROBES.findIndex((p, n) => answer(p, ctx) !== baselines[v][n]);
    if (i !== -1) return i;
  }
  return -1;
};

// --- mutants ------------------------------------------------------------------------------------------------------------
const catalogScopes = [...new Set(Object.values(TOOLS).map((t) => t.scope))];
const OTHER = { effect: ['allow', 'deny', 'pause'], op: ['gt', 'gte', 'lt', 'lte', 'eq'] };
// What a grant list can usefully gain, by the name of the list. An extra value no tool or rule uses would be an equivalent mutant.
const additions = (key, list) => {
  if (key === 'surfaces') return SURFACES.filter((x) => !list.includes(x));
  if (key === 'scopes') return catalogScopes.filter((x) => !list.includes(x));
  if (key === 'tools' || key === 'agents') return list.includes('*') ? [] : ['*'];
  return [];
};
const at = (root, path) => path.reduce((n, k) => n[k], root);

// Yields { label, mutate(ctx) }. Every leaf and every entry of { registry, rules } is visited; upstream is skipped (see the header).
function* walk(node, path) {
  const here = path.join('.');
  const key = path[path.length - 1];
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      const p = [...path, i];
      if (el !== null && typeof el === 'object') {
        yield { label: `${p.join('.')} remove entry`, mutate: (ctx) => { at(ctx, path).splice(i, 1); } };
        yield* walk(el, p);
      } else {
        yield { label: `${p.join('.')} remove ${JSON.stringify(el)}`, mutate: (ctx) => { at(ctx, path).splice(i, 1); } };
        yield { label: `${p.join('.')} replace ${JSON.stringify(el)}`, mutate: (ctx) => { at(ctx, path)[i] = 'mutant-x'; } };
      }
    }
    for (const add of additions(key, node)) yield { label: `${here} grant ${add}`, mutate: (ctx) => { at(ctx, path).push(add); } };
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'upstream') continue;
    const p = [...path, k];
    const label = p.join('.');
    if (v !== null && typeof v === 'object') {
      if (path.length >= 1 && !Array.isArray(v)) yield { label: `${label} remove entry`, mutate: (ctx) => { delete at(ctx, path)[k]; } };
      yield* walk(v, p);
    } else if (typeof v === 'string') {
      yield { label: `${label} replace ${JSON.stringify(v)}`, mutate: (ctx) => { at(ctx, path)[k] = 'mutant-x'; } };
      for (const o of OTHER[k] ?? []) if (o !== v) yield { label: `${label} -> ${o}`, mutate: (ctx) => { at(ctx, path)[k] = o; } };
    } else if (typeof v === 'boolean') {
      yield { label: `${label} flip`, mutate: (ctx) => { at(ctx, path)[k] = !v; } };
    } else if (typeof v === 'number') {
      yield { label: `${label} - 1`, mutate: (ctx) => { at(ctx, path)[k] = v - 1; } };
      yield { label: `${label} + 1`, mutate: (ctx) => { at(ctx, path)[k] = v + 1; } };
    }
  }
}

test('the probe set is large and real: it covers every agent, token, tool, surface and a spread of arguments', () => {
  assert.ok(PROBES.length > 5000, `probes: ${PROBES.length}`);
  const decisions = new Set(baselines[0].map((a) => JSON.parse(a).decision));
  assert.deepEqual([...decisions].sort(), ['allow', 'deny', 'pause']);
  const reasons = new Set(baselines[0].map((a) => JSON.parse(a).reason));
  for (const r of ['scope_surface', 'scope_application', 'scope_exceeded', 'scope_end_user', 'token_invalid', 'rate_limited', 'prompt_injection', 'amount_over_limit', 'needs_human_approval', 'rule_allow', 'default_deny', 'unknown_agent', 'unknown_tool', 'bad_arguments']) assert.ok(reasons.has(r), `no probe reaches ${r}`);
});

test('no mutant of any editable policy field survives: every change to a token, application, end user, agent, tool scope or rule changes an answer', (t) => {
  const survivors = [];
  let count = 0;
  for (const m of walk(BASE, [])) {
    const ctx = clone(BASE);
    m.mutate(ctx);
    count += 1;
    if (killedBy(ctx) === -1) survivors.push(m.label);
  }
  t.diagnostic(`mutants tried: ${count}, survivors: ${survivors.length}, equivalent (listed): ${equivalent.length}`);
  assert.ok(count > 200, `mutants: ${count}`);
  assert.deepEqual(survivors.filter((l) => !equivalent.includes(l)), [], 'a policy field no probe can see');
  assert.deepEqual(survivors.filter((l) => equivalent.includes(l)).sort(), [...equivalent].sort(), 'every listed equivalent mutant really survives (the list is not padded)');
});

// allow-small-transfer says amount >= 0 and <= 500. The upper bound is redundant: pause-large-transfer matches every amount
// above 500 and pause beats allow, so removing or raising the bound changes no answer. That holds only while the two bounds agree.
const equivalent = ['rules.6.when.1 remove entry', 'rules.6.when.1.value + 1'];
test('the only equivalent mutants are the redundant upper bound of allow-small-transfer, and that is true by construction', () => {
  const allow = RULES.find((r) => r.id === 'allow-small-transfer');
  const pause = RULES.find((r) => r.id === 'pause-large-transfer');
  assert.equal(RULES.indexOf(allow), 6);
  assert.deepEqual([allow.when[1].op, pause.when[0].op], ['lte', 'gt']);
  assert.equal(allow.when[1].value, pause.when[0].value);
  assert.ok(RULES.some((r) => r.id === 'deny-huge-transfer' && r.when[0].value > pause.when[0].value));
});

test('the harness can fail: a mutant that changes nothing survives, and a real one is killed (so a green run means something)', () => {
  assert.equal(killedBy(clone(BASE)), -1, 'an unchanged copy survives');
  const real = clone(BASE); real.registry.tokens['tok-support'].surfaces = ['a2a'];
  assert.notEqual(killedBy(real), -1);
  const noop = clone(BASE); noop.registry.tools['tickets.read'].upstream = 'mutant-x';
  assert.equal(killedBy(noop), -1, 'upstream is routing: evaluate() cannot see it, which is why the header says so');
});
