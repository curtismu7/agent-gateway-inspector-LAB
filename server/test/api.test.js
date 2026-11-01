import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { fakeClock } from './fixtures.js';
import { freeBase, request } from './helpers.js';

async function boot(t, { runtime, health } = {}) {
  const base = await freeBase('api', 4);
  const clock = fakeClock();
  const rt = runtime || await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000 });
  const h = health || createHealth();
  const port = base + 3;
  const server = createApp({ runtime: rt, health: h }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { h.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  return { port, rt, clock };
}
const run = (port, id, body) => request(port, 'POST', `/api/scenarios/${id}/run`, body === undefined ? {} : { body });

test('GET /api/health is demo-health/1, no-store, offline', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.schema, 'demo-health/1');
  assert.equal(res.json.state, 'ready');
  assert.equal(res.json.runtime, 'offline');
  assert.deepEqual(Object.keys(res.json).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
  assert.equal(res.json.demo.id, 'agent-gateway-inspector');
  assert.ok(res.json.demo.id.length <= 64 && res.json.demo.name.length <= 80 && res.json.demo.version.length <= 32);
  assert.ok(!Number.isNaN(Date.parse(res.json.at)));
  assert.ok(res.raw.length < 4096);
  assert.equal((await request(port, 'POST', '/api/health')).status, 405);
});

test('health reports broken when the doctor fails, without any detail', async (t) => {
  const health = createHealth({ runChecks: () => [{ id: 'x', level: 'fail', detail: 'secret-ish detail' }] });
  const { port } = await boot(t, { health });
  const res = await request(port, 'GET', '/api/health');
  assert.equal(res.json.state, 'broken');
  assert.doesNotMatch(res.raw, /secret-ish/);
});

test('GET /api/scenarios lists the twelve scripted scenarios', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'GET', '/api/scenarios');
  assert.deepEqual(res.json.scenarios.map((s) => s.id), ['benign', 'scope-exceeding', 'prompt-injection', 'rate-burst', 'paused-approved', 'paused-expired', 'surface-denied', 'application-denied', 'end-user-denied', 'hold-unattended', 'hold-replay-refused', 'hold-args-changed']);
});

test('POST /api/scenarios/:id/run gives the expected decision for each scenario', async (t) => {
  const { port } = await boot(t);
  const want = {
    'benign': ['allow', 'forwarded'], 'scope-exceeding': ['deny', 'blocked'], 'prompt-injection': ['deny', 'blocked'],
    'paused-approved': ['pause', 'forwarded'], 'paused-expired': ['pause', 'expired'],
    'surface-denied': ['deny', 'blocked'], 'application-denied': ['deny', 'blocked'], 'end-user-denied': ['deny', 'blocked'],
    'hold-unattended': ['pause', 'held'], 'hold-replay-refused': ['pause', 'held'], 'hold-args-changed': ['pause', 'held'],
  };
  for (const [id, [decision, outcome]] of Object.entries(want)) {
    const res = await run(port, id);
    assert.equal(res.status, 200, id);
    assert.equal(res.json.matched, true, id);
    assert.deepEqual([res.json.calls[0].decision, res.json.calls[0].outcome], [decision, outcome], id);
  }
  const burst = await run(port, 'rate-burst');
  assert.deepEqual(burst.json.calls.map((c) => c.reason).slice(-2), ['rate_limited', 'rate_limited']);
});

test('unknown scenario 404; bad body fields 400; unknown routes 404', async (t) => {
  const { port } = await boot(t);
  assert.equal((await run(port, 'nope')).status, 404);
  assert.equal((await run(port, 'benign', { agentId: 'finance-agent', tool: 'payments.transfer' })).status, 400, 'no way to submit a call');
  assert.equal((await run(port, 'benign', { hold: 'yes' })).status, 400);
  assert.equal((await run(port, 'benign', { hold: false })).status, 200);
  assert.equal((await request(port, 'GET', '/api/nothing')).status, 404);
  assert.equal((await request(port, 'GET', '/')).status, 404);
  assert.equal((await request(port, 'POST', '/api/scenarios/benign/run', { body: '{bad json' })).status, 400);
  assert.equal((await request(port, 'POST', '/api/scenarios/benign/run', { body: { a: 'x'.repeat(5000) } })).status, 413);
});

test('calls: list with polling cursor, detail, malformed id, unknown id', async (t) => {
  const { port } = await boot(t);
  await run(port, 'benign');
  const list = await request(port, 'GET', '/api/calls');
  assert.equal(list.status, 200);
  assert.equal(list.json.calls.length, 1);
  const cursor = list.json.cursor;
  assert.deepEqual((await request(port, 'GET', `/api/calls?since=${cursor}`)).json.calls, []);
  await run(port, 'scope-exceeding');
  const next = await request(port, 'GET', `/api/calls?since=${cursor}`);
  assert.equal(next.json.calls.length, 1);
  assert.equal(next.json.calls[0].reason, 'scope_exceeded');
  const one = await request(port, 'GET', `/api/calls/${list.json.calls[0].id}`);
  assert.equal(one.json.call.decision, 'allow');
  assert.equal((await request(port, 'GET', '/api/calls/call-9999')).status, 404);
  assert.equal((await request(port, 'GET', '/api/calls/..%2f..%2fetc')).status, 400);
  assert.equal((await request(port, 'GET', '/api/calls/%ZZ')).status, 400);
  for (const q of ['since=-1', 'since=abc', 'limit=0', 'limit=99999', 'since=1e9']) assert.equal((await request(port, 'GET', `/api/calls?${q}`)).status, 400, q);
});

test('human in the loop over HTTP: held scenario, wrong code, approve, replay', async (t) => {
  const { port, rt } = await boot(t);
  const held = await run(port, 'paused-approved', { hold: true });
  const id = held.json.calls[0].id;
  assert.equal(held.json.calls[0].outcome, 'pending');
  assert.ok(!held.raw.includes('approvalCode'), 'the run response carries no code');
  assert.ok(!(await request(port, 'GET', '/api/calls')).raw.includes('approvalCode'), 'the list carries no code');
  const detail = await request(port, 'GET', `/api/calls/${id}`);
  const code = detail.json.call.pause.approvalCode;
  assert.match(code, /^[0-9a-f]{32}$/);
  assert.equal((await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: 'nope' } })).status, 403);
  assert.deepEqual(rt.upstreams.hits, []);
  const ok = await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: code } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.call.outcome, 'forwarded');
  assert.equal(rt.upstreams.hits.length, 1);
  const replay = await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: code } });
  assert.equal(replay.status, 409);
  assert.equal(rt.upstreams.hits.length, 1);
});

test('decision body is strict', async (t) => {
  const { port } = await boot(t);
  const held = await run(port, 'paused-approved', { hold: true });
  const id = held.json.calls[0].id;
  for (const body of [{}, { decision: 'approve' }, { approvalCode: 'x' }, { decision: 'approve', approvalCode: 'x', extra: 1 }, { decision: 5, approvalCode: 'x' }, { decision: 'approve', approvalCode: ['x'] }, { decision: 'approve', approvalCode: 'x'.repeat(65) }]) {
    assert.equal((await request(port, 'POST', `/api/calls/${id}/decision`, { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(port, 'POST', `/api/calls/${id}/decision`)).status, 400);
  assert.equal((await request(port, 'POST', '/api/calls/call-9999/decision', { body: { decision: 'deny', approvalCode: 'x' } })).status, 404);
  assert.equal((await request(port, 'GET', `/api/calls/${id}`)).json.call.outcome, 'pending');
});

test('expiry over HTTP: a held pause that outlives its ttl cannot be approved', async (t) => {
  const { port, clock, rt } = await boot(t);
  const held = await run(port, 'paused-expired', { hold: true });
  const id = held.json.calls[0].id;
  const code = (await request(port, 'GET', `/api/calls/${id}`)).json.call.pause.approvalCode;
  clock.advance(1000);
  const late = await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: code } });
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'expired');
  assert.equal((await request(port, 'GET', `/api/calls/${id}`)).json.call.outcome, 'expired');
  assert.deepEqual(rt.upstreams.hits, []);
});

test('audit: read-only listing with a cursor, verify, and no write verb works on it', async (t) => {
  const { port } = await boot(t);
  await run(port, 'benign');
  const a = await request(port, 'GET', '/api/audit');
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.entries.map((e) => e.type), ['decision', 'forwarded']);
  assert.equal((await request(port, 'GET', `/api/audit?after=${a.json.headSeq}`)).json.entries.length, 0);
  const v = await request(port, 'GET', '/api/audit/verify');
  assert.equal(v.json.ok, true);
  assert.equal(v.json.headHash, a.json.entries.at(-1).hash);
  for (const path of ['/api/audit', '/api/audit/verify', '/api/audit/1', '/api/audit/verify/x']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(port, method, path, { body: { type: 'forged' } });
      assert.ok([404, 405].includes(res.status), `${method} ${path} -> ${res.status}`);
    }
  }
  const after = await request(port, 'GET', '/api/audit');
  assert.deepEqual(after.json.entries, a.json.entries, 'nothing changed');
  assert.equal((await request(port, 'GET', '/api/audit/verify')).json.ok, true);
});

test('audit entries cannot be changed through the calls API either', async (t) => {
  const { port } = await boot(t);
  await run(port, 'benign');
  const before = (await request(port, 'GET', '/api/audit')).raw;
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await request(port, method, '/api/calls/call-0001', { body: { decision: 'deny' } });
    assert.ok([404, 405].includes(r.status));
  }
  assert.equal((await request(port, 'GET', '/api/audit')).raw, before);
});

test('reset clears the buffer and leaves a verifiable audit chain starting with a reset marker', async (t) => {
  const { port } = await boot(t);
  await run(port, 'benign');
  assert.equal((await request(port, 'POST', '/api/reset', { body: { x: 1 } })).status, 400);
  assert.equal((await request(port, 'POST', '/api/reset')).json.ok, true);
  assert.deepEqual((await request(port, 'GET', '/api/calls')).json.calls, []);
  const a = await request(port, 'GET', '/api/audit');
  assert.deepEqual(a.json.entries.map((e) => e.type), ['reset']);
  assert.equal((await request(port, 'GET', '/api/audit/verify')).json.ok, true);
});

test('a third concurrent scenario run gets 429 with Retry-After', async (t) => {
  const { port } = await boot(t);
  const rs = await Promise.all([1, 2, 3, 4].map(() => run(port, 'benign')));
  const codes = rs.map((r) => r.status);
  assert.ok(codes.includes(429), codes.join());
  assert.equal(rs.find((r) => r.status === 429).headers['retry-after'], '2');
});

test('responses are JSON with nosniff and a locked-down CSP', async (t) => {
  const { port } = await boot(t);
  const res = await request(port, 'GET', '/api/calls');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'");
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('a 500 never leaks err.message or a stack', async (t) => {
  const { port, rt } = await boot(t);
  rt.gateway.list = () => { throw new Error('SECRET internal path /Users/x/db'); };
  const res = await request(port, 'GET', '/api/calls');
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'server_error' });
  assert.doesNotMatch(res.raw, /SECRET|Users|at /);
});
