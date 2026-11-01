// Ping release claim (2026-11-02), UNVERIFIED on our tenant. The scope layers, the hold outcome and the single-use,
// call-bound approval over HTTP, with the new retry route, the CSRF and credential guards in front of it, the zero-outbound
// guarantee for the new code paths, and Reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createRuntime } from '../src/runtime.js';
import { SCENARIOS } from '../src/scenarios.js';
import { fakeClock } from './fixtures.js';
import { freeBase, request } from './helpers.js';
import { guardNetwork } from './netguard.js';

async function boot(t) {
  const base = await freeBase('spare', 4);
  const clock = fakeClock();
  const rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000 });
  const h = createHealth();
  const port = base + 3;
  const server = createApp({ runtime: rt, health: h }).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { h.stop(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await rt.close(); });
  return { port, rt, clock };
}
const run = (port, id, body) => request(port, 'POST', `/api/scenarios/${id}/run`, body === undefined ? {} : { body });
const sameOrigin = (port) => ({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
const NEW = ['surface-denied', 'application-denied', 'end-user-denied', 'hold-unattended', 'hold-replay-refused', 'hold-args-changed'];

test('every new scenario ends in the decision it states, and only the exact approved retry reaches an upstream', async (t) => {
  const { port, rt } = await boot(t);
  const want = { 'surface-denied': 0, 'application-denied': 0, 'end-user-denied': 0, 'hold-unattended': 1, 'hold-replay-refused': 1, 'hold-args-changed': 1 };
  for (const id of NEW) {
    rt.upstreams.reset();
    const res = await run(port, id);
    assert.equal(res.status, 200, id);
    assert.equal(res.json.matched, true, `${id}: ${JSON.stringify(res.json.calls.map((c) => [c.decision, c.outcome, c.reason]))}`);
    assert.equal(rt.upstreams.hits.length, want[id], `${id}: upstream hits`);
  }
  assert.equal(SCENARIOS.length, 12);
});

test('the replay scenario ends in approval_consumed and the changed-argument scenario in approval_mismatch then a good retry', async (t) => {
  const { port } = await boot(t);
  const replay = (await run(port, 'hold-replay-refused')).json.calls;
  assert.deepEqual(replay.map((c) => c.reason), ['needs_human_approval', 'hold_approved', 'approval_consumed']);
  assert.deepEqual(replay.map((c) => c.outcome), ['held', 'forwarded', 'blocked']);
  assert.equal(replay[0].hold.state, 'consumed');
  assert.equal(replay[0].hold.consumedByCallId, replay[1].id);
  const changed = (await run(port, 'hold-args-changed')).json.calls;
  assert.deepEqual(changed.map((c) => c.reason), ['needs_human_approval', 'approval_mismatch', 'hold_approved']);
  assert.equal(changed[0].hold.consumedByCallId, changed[2].id, 'the refused changed call did not spend the approval');
  assert.equal(changed[1].approvalRef, changed[0].hold.ref);
});

test('the layer evidence is served with the call: four named layers, the first failing one, and the claims read from the token', async (t) => {
  const { port } = await boot(t);
  const surface = (await run(port, 'surface-denied')).json.calls[0];
  assert.deepEqual(surface.layers, { surface: 'fail', application: 'skipped', action: 'skipped', endUser: 'skipped' });
  assert.equal(surface.claims.surface, 'llm');
  const user = (await run(port, 'end-user-denied')).json.calls[0];
  assert.deepEqual(user.layers, { surface: 'pass', application: 'pass', action: 'pass', endUser: 'fail' });
  assert.deepEqual([user.claims.endUser, user.claims.subject], ['user-analyst', 'tok-finance-analyst']);
  const ok = (await run(port, 'benign')).json.calls[0];
  assert.deepEqual(Object.values(ok.layers), ['pass', 'pass', 'pass', 'pass']);
});

test('hold over HTTP: held run, no code in the run or list, refused before approval, approve forwards nothing, one retry forwards once, the next is refused', async (t) => {
  const { port, rt } = await boot(t);
  const held = await run(port, 'hold-unattended', { hold: true });
  assert.equal(held.json.held, true);
  assert.equal(held.json.matched, null);
  assert.equal(held.json.calls.length, 1, 'the agent\'s retry is not run until a human has answered');
  const c = held.json.calls[0];
  assert.deepEqual([c.decision, c.outcome], ['pause', 'held']);
  assert.ok(!held.raw.includes('approvalCode') && !(await request(port, 'GET', '/api/calls')).raw.includes('approvalCode'));
  const code = (await request(port, 'GET', `/api/calls/${c.id}`)).json.call.hold.approvalCode;
  assert.match(code, /^[0-9a-f]{32}$/);

  const early = await request(port, 'POST', `/api/calls/${c.id}/retry`);
  assert.equal(early.status, 200);
  assert.deepEqual([early.json.call.decision, early.json.call.reason], ['deny', 'approval_pending']);
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: 'nope' } })).status, 403);
  assert.deepEqual(rt.upstreams.hits, []);

  const ok = await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.call.outcome, ok.json.call.hold.state], ['held', 'approved']);
  assert.deepEqual(rt.upstreams.hits, [], 'approving forwards nothing');
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code } })).status, 409);

  const first = await request(port, 'POST', `/api/calls/${c.id}/retry`);
  assert.deepEqual([first.json.call.reason, first.json.call.outcome], ['hold_approved', 'forwarded']);
  assert.equal(rt.upstreams.hits.length, 1);
  const second = await request(port, 'POST', `/api/calls/${c.id}/retry`);
  assert.deepEqual([second.json.call.reason, second.json.call.outcome], ['approval_consumed', 'blocked']);
  assert.equal(rt.upstreams.hits.length, 1, 'the replay never reached the upstream');
});

test('hold over HTTP: expiry. An undecided hold cannot be approved late, and an unused grant cannot be retried late', async (t) => {
  const { port, clock, rt } = await boot(t);
  const a = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
  const codeA = (await request(port, 'GET', `/api/calls/${a.id}`)).json.call.hold.approvalCode;
  clock.advance(31_000);
  const late = await request(port, 'POST', `/api/calls/${a.id}/decision`, { body: { decision: 'approve', approvalCode: codeA } });
  assert.deepEqual([late.status, late.json.error], [409, 'expired']);
  assert.equal((await request(port, 'POST', `/api/calls/${a.id}/retry`)).json.call.reason, 'approval_expired');

  const b = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
  const codeB = (await request(port, 'GET', `/api/calls/${b.id}`)).json.call.hold.approvalCode;
  assert.equal((await request(port, 'POST', `/api/calls/${b.id}/decision`, { body: { decision: 'approve', approvalCode: codeB } })).status, 200);
  clock.advance(61_000);
  assert.equal((await request(port, 'POST', `/api/calls/${b.id}/retry`)).json.call.reason, 'approval_expired');
  assert.deepEqual(rt.upstreams.hits, []);
});

test('the retry route is strict: malformed id 400, unknown call 404, a call that is not held 409, any body 400, only POST', async (t) => {
  const { port } = await boot(t);
  const benign = (await run(port, 'benign')).json.calls[0];
  for (const id of ['x', 'call-1', 'call-0001%00', 'CALL-0001', 'call-' + '9'.repeat(40)]) {
    assert.equal((await request(port, 'POST', `/api/calls/${id}/retry`)).status, 400, id);
  }
  assert.equal((await request(port, 'POST', '/api/calls/call-9999/retry')).status, 404);
  const notHeld = await request(port, 'POST', `/api/calls/${benign.id}/retry`);
  assert.deepEqual([notHeld.status, notHeld.json.error], [409, 'not_held']);
  const held = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
  for (const body of [{ amount: 1 }, { approvalRef: 'hold-0000000000000000' }, { args: {} }, { tokenId: 'tok-finance' }, { agentId: 'finance-agent' }, { surface: 'mcp' }]) {
    assert.equal((await request(port, 'POST', `/api/calls/${held.id}/retry`, { body })).status, 400, JSON.stringify(body));
  }
  for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await request(port, m, `/api/calls/${held.id}/retry`, m === 'GET' ? {} : { body: {} })).status === 200, false, m);
  assert.equal((await request(port, 'GET', `/api/calls/${held.id}`)).json.call.hold.state, 'pending', 'none of those changed the hold');
});

test('CSRF and credentials: a cross-origin page cannot make the agent retry, and a typed credential is refused and never echoed', async (t) => {
  const { port, rt } = await boot(t);
  const c = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
  const code = rt.gateway.get(c.id).hold.approvalCode;
  await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code }, headers: sameOrigin(port) });
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { origin: `http://127.0.0.1:${port}.evil.example` }]) {
    const res = await request(port, 'POST', `/api/calls/${c.id}/retry`, { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/retry`, { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.deepEqual(rt.upstreams.hits, [], 'no refused request forwarded anything');
  const secret = ['sk', 'live', 'Z9y8X7w6V5u4T3s2R1q0P9o8'].join('-');
  for (const [path, body] of [[`/api/calls/${c.id}/retry`, undefined], [`/api/calls/${c.id}/decision`, { decision: 'approve', approvalCode: 'x' }], ['/api/scenarios/hold-unattended/run', {}]]) {
    for (const h of [{ authorization: `Bearer ${secret}` }, { 'x-api-key': secret }, { 'proxy-authorization': `Basic ${secret}` }]) {
      const res = await request(port, 'POST', path, { body, headers: h });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'credentials_not_accepted');
      assert.ok(!res.raw.includes(secret), 'the credential is not echoed');
    }
  }
  // a retry with the right origin still works, once
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/retry`, { headers: sameOrigin(port) })).json.call.outcome, 'forwarded');
});

test('zero outbound: every scenario, the hold flow, the retry route, a replay and a reset make no non-loopback socket, DNS lookup or fetch', async (t) => {
  const { port, rt } = await boot(t);
  const g = guardNetwork();
  try {
    for (const sc of SCENARIOS) assert.equal((await run(port, sc.id)).json.matched, true, sc.id);
    const c = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
    const code = (await request(port, 'GET', `/api/calls/${c.id}`)).json.call.hold.approvalCode;
    await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code } });
    await request(port, 'POST', `/api/calls/${c.id}/retry`);
    await request(port, 'POST', `/api/calls/${c.id}/retry`);
    await request(port, 'GET', '/api/audit/verify');
    await request(port, 'POST', '/api/reset');
  } finally { g.restore(); }
  assert.deepEqual(g.attempts, [], 'no non-loopback connection was attempted');
  assert.deepEqual(rt.upstreams.hits, []);
});

test('Reset restores the new state: holds, approvals and retries are gone, the old call id is 404, and the audit chain starts a new epoch', async (t) => {
  const { port, rt } = await boot(t);
  const c = (await run(port, 'hold-unattended', { hold: true })).json.calls[0];
  const code = rt.gateway.get(c.id).hold.approvalCode;
  await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code } });
  assert.equal((await request(port, 'GET', '/api/calls')).json.stats.pending, 1);
  assert.equal((await request(port, 'POST', '/api/reset')).status, 200);
  const after = await request(port, 'GET', '/api/calls');
  assert.deepEqual([after.json.calls.length, after.json.stats.pending], [0, 0]);
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/retry`)).status, 404);
  assert.equal((await request(port, 'POST', `/api/calls/${c.id}/decision`, { body: { decision: 'approve', approvalCode: code } })).status, 404);
  assert.equal((await request(port, 'GET', '/api/audit/verify')).json.ok, true);
  assert.deepEqual(rt.upstreams.hits, []);
  // and a fresh run works again from a clean state
  assert.equal((await run(port, 'hold-unattended')).json.matched, true);
});

test('hostile input is bounded: scenario ids, call ids and bodies that try to reach the new fields are refused', async (t) => {
  const { port } = await boot(t);
  for (const id of ['__proto__', 'constructor', 'hold-unattended%00', 'x'.repeat(200), 'HOLD-UNATTENDED']) assert.ok([400, 404].includes((await run(port, id)).status), id);
  for (const body of [{ tokenId: 'tok-finance-batch' }, { surface: 'mcp' }, { approvalRef: 'hold-0000000000000000' }, { claims: { endUser: 'user-manager' } }, { scopes: ['payments:write'] }, { attended: true }]) {
    assert.equal((await run(port, 'benign', body)).status, 400, JSON.stringify(body));
  }
  const big = await request(port, 'POST', '/api/scenarios/benign/run', { body: { hold: false, pad: 'x'.repeat(5000) } });
  assert.equal(big.status, 413);
});

test('the windows are what the docs say: a hold can be answered for 30 s, an approval can be used for 60 s after it is given, and each is gone just after', async (t) => {
  const { port, clock } = await boot(t);
  const codes = new Map();
  const answer = async (id) => (await request(port, 'POST', `/api/calls/${id}/decision`, { body: { decision: 'approve', approvalCode: codes.get(id) } })).status;
  const open = async () => { const id = (await run(port, 'hold-unattended', { hold: true })).json.calls[0].id; codes.set(id, (await request(port, 'GET', `/api/calls/${id}`)).json.call.hold.approvalCode); return id; };
  const a = await open();
  clock.advance(29_000);
  assert.equal(await answer(a), 200, 'still answerable at 29 s');
  clock.advance(59_000);
  assert.equal((await request(port, 'POST', `/api/calls/${a}/retry`)).json.call.reason, 'hold_approved', 'still usable 59 s after approval');
  const b = await open();
  assert.equal(await answer(b), 200);
  clock.advance(61_000);
  assert.equal((await request(port, 'POST', `/api/calls/${b}/retry`)).json.call.reason, 'approval_expired', 'gone after 61 s');
  const c = await open();
  clock.advance(31_000);
  assert.equal(await answer(c), 409, 'an unanswered hold is gone after 31 s');
});
