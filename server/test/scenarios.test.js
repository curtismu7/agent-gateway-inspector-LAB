import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { SCENARIOS } from '../src/scenarios.js';
import { PAUSE_TTL_MS } from '../src/policy.js';
import { fakeClock } from './fixtures.js';
import { freeBase } from './helpers.js';

async function boot(t) {
  const base = await freeBase('scenarios', 3);
  const clock = fakeClock();
  const rt = await createRuntime({ stubBase: base, now: clock.now, sleep: async (ms) => clock.advance(ms), upstreamTimeoutMs: 30_000 });
  t.after(() => rt.close());
  return { rt, clock };
}

test('every scripted scenario ends in the decision it states, over real loopback upstreams', async (t) => {
  const { rt } = await boot(t);
  assert.deepEqual(SCENARIOS.map((s) => s.id), ['benign', 'scope-exceeding', 'prompt-injection', 'rate-burst', 'paused-approved', 'paused-expired', 'surface-denied', 'application-denied', 'end-user-denied', 'hold-unattended', 'hold-replay-refused', 'hold-args-changed']);
  for (const sc of SCENARIOS) {
    const r = await rt.runScenario(sc.id);
    assert.equal(r.matched, true, `${sc.id}: ${JSON.stringify(r.calls.map((c) => [c.decision, c.outcome, c.reason]))}`);
    assert.equal(r.calls.length, sc.expected.length);
  }
});

test('benign reaches the upstream; denied and expired calls never do', async (t) => {
  const { rt } = await boot(t);
  await rt.runScenario('benign');
  assert.deepEqual(rt.upstreams.hits, [{ upstream: 'tickets', tool: 'tickets.read' }]);
  rt.upstreams.reset();
  for (const id of ['scope-exceeding', 'prompt-injection', 'paused-expired']) await rt.runScenario(id);
  assert.deepEqual(rt.upstreams.hits, [], 'nothing was forwarded');
});

test('rate-burst: exactly the first five reach the upstream', async (t) => {
  const { rt } = await boot(t);
  const r = await rt.runScenario('rate-burst');
  assert.deepEqual(r.calls.map((c) => c.outcome), ['forwarded', 'forwarded', 'forwarded', 'forwarded', 'forwarded', 'blocked', 'blocked']);
  assert.equal(rt.upstreams.hits.length, 5);
});

test('paused-approved: forwarded only after the approval, with the audit trail to show it', async (t) => {
  const { rt } = await boot(t);
  const r = await rt.runScenario('paused-approved');
  assert.equal(r.calls[0].outcome, 'forwarded');
  assert.equal(r.calls[0].pause.state, 'approved');
  assert.deepEqual(rt.upstreams.hits, [{ upstream: 'payments', tool: 'payments.transfer' }]);
  const types = rt.gateway.audit.list().map((e) => e.type);
  assert.ok(types.indexOf('pause_approved') < types.indexOf('forwarded'));
});

test('paused-expired: the late approval with the right code is refused as expired', async (t) => {
  const { rt } = await boot(t);
  const r = await rt.runScenario('paused-expired');
  assert.equal(r.lateApproval, 'expired');
  assert.equal(r.calls[0].outcome, 'expired');
});

test('hold: a paused scenario leaves the call pending for a human, and the late human can still approve', async (t) => {
  const { rt } = await boot(t);
  const r = await rt.runScenario('paused-approved', { hold: true });
  assert.equal(r.held, true);
  assert.equal(r.matched, null);
  assert.equal(r.calls[0].outcome, 'pending');
  assert.equal(r.calls[0].pause.approvalCode, undefined);
  assert.deepEqual(rt.upstreams.hits, []);
  const code = rt.gateway.get(r.calls[0].id).pause.approvalCode;
  assert.equal((await rt.gateway.decide(r.calls[0].id, { decision: 'approve', approvalCode: code })).call.outcome, 'forwarded');
});

test('scenarios can be run back to back: each starts with a fresh rate window', async (t) => {
  const { rt } = await boot(t);
  for (let i = 0; i < 3; i++) for (const id of ['rate-burst', 'benign', 'prompt-injection']) assert.equal((await rt.runScenario(id)).matched, true, `${id} round ${i}`);
});

test('a hostile upstream answer is shown inert and redacted (T-666)', async (t) => {
  const { rt } = await boot(t);
  const c = await rt.gateway.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-666' } });
  const d = rt.gateway.get(c.id);
  const s = JSON.stringify(d);
  assert.match(s, /\[U\+200B\]/);
  assert.match(s, /\[U\+202E\]/);
  assert.doesNotMatch(s, /hunter2/);
  assert.doesNotMatch(s, /[\u200B\u202E]/);
});

test('the pause ttl is the gateway constant', () => {
  assert.equal(PAUSE_TTL_MS, 30_000);
});

test('scenario queue: a third concurrent run is refused', async (t) => {
  const { rt } = await boot(t);
  const runs = [rt.runScenario('benign'), rt.runScenario('benign')];
  await assert.rejects(rt.runScenario('benign'), { code: 'scenario_queue_full' });
  await Promise.all(runs);
});

test('reset empties the buffer and the upstream hit log', async (t) => {
  const { rt } = await boot(t);
  await rt.runScenario('benign');
  rt.reset();
  assert.equal(rt.gateway.list().calls.length, 0);
  assert.deepEqual(rt.upstreams.hits, []);
  assert.equal(rt.gateway.audit.verify().ok, true);
});
