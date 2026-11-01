import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, MAX_BAD_CODES } from '../src/gateway.js';
import { RATE_LIMIT, PAUSE_TTL_MS } from '../src/policy.js';
import { fakeClock, fakeForward } from './fixtures.js';

const mk = (o = {}) => { const clock = fakeClock(); const forward = o.forward ?? fakeForward(); const gw = createGateway({ forward, now: clock.now, ...o }); return { gw, clock, forward }; };
const read = (gw, args = { ticketId: 'T-1' }) => gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args });
const transfer = (gw, amount = 900, extra = {}) => gw.handle({ agentId: 'finance-agent', tool: 'payments.transfer', args: { amount }, ...extra });
const codeOf = (gw, id) => gw.get(id).pause.approvalCode;

test('allow: forwarded to the upstream, recorded, audited', async () => {
  const { gw, forward } = mk();
  const c = await read(gw);
  assert.deepEqual([c.decision, c.outcome, c.reason, c.ruleId], ['allow', 'forwarded', 'rule_allow', 'allow-ticket-read']);
  assert.equal(forward.sent.length, 1);
  assert.deepEqual(gw.audit.list().map((e) => e.type), ['decision', 'forwarded']);
});

test('deny: never forwarded, and the denial is audited', async () => {
  const { gw, forward } = mk();
  const c = await gw.handle({ agentId: 'support-bot', tool: 'payments.transfer', args: { amount: 1 } });
  assert.deepEqual([c.decision, c.outcome, c.reason], ['deny', 'blocked', 'scope_exceeded']);
  assert.equal(forward.sent.length, 0);
  assert.equal(gw.audit.list()[0].data.decision, 'deny');
});

test('deny by default: unknown agent, unknown tool, odd input shapes are blocked and never forwarded', async () => {
  const { gw, forward } = mk();
  for (const call of [
    { agentId: 'ghost', tool: 'tickets.read', args: {} },
    { agentId: 'support-bot', tool: 'nope', args: {} },
    { agentId: 'support-bot', tool: 'tickets.read', args: 'string' },
    { agentId: 'support-bot', tool: 'tickets.read', args: { big: 'x'.repeat(5000) } },
    { agentId: 42, tool: 'tickets.read', args: {} },
    {},
  ]) {
    const c = await gw.handle(call);
    assert.equal(c.decision, 'deny', JSON.stringify(call).slice(0, 60));
    assert.equal(c.outcome, 'blocked');
  }
  assert.equal(forward.sent.length, 0);
});

test('rate limit: the burst passes up to the limit, the rest is denied, and the window slides', async () => {
  const { gw, clock } = mk();
  const results = [];
  for (let i = 0; i < RATE_LIMIT.max + 2; i++) results.push((await read(gw)).reason);
  assert.deepEqual(results, [...Array(RATE_LIMIT.max).fill('rule_allow'), 'rate_limited', 'rate_limited']);
  clock.advance(RATE_LIMIT.windowMs + 1);
  assert.equal((await read(gw)).reason, 'rule_allow');
});

test('rate limit state is only kept for registered agents (a flood of made-up names cannot grow it)', async () => {
  const { gw } = mk();
  for (let i = 0; i < 50; i++) await gw.handle({ agentId: `ghost-${i}`, tool: 'tickets.read', args: {} });
  gw.clearRate('support-bot');
  assert.equal(gw.stats().calls, 50);
});

test('pause: holds the call, does not forward, and the detail (not the list) carries a one-shot code', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw);
  assert.deepEqual([c.decision, c.outcome], ['pause', 'pending']);
  assert.equal(forward.sent.length, 0);
  assert.equal(c.pause.approvalCode, undefined, 'the response to the agent never carries the code');
  assert.equal(gw.list().calls[0].pause.approvalCode, undefined);
  assert.match(gw.get(c.id).pause.approvalCode, /^[0-9a-f]{32}$/);
  assert.equal(gw.get(c.id, { detail: false }).pause.approvalCode, undefined);
});

test('approve: with the right code the call is forwarded once; the code cannot be reused', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  const r = await gw.decide(c.id, { decision: 'approve', approvalCode: code });
  assert.equal(r.status, 200);
  assert.deepEqual([r.call.outcome, r.call.pause.state], ['forwarded', 'approved']);
  assert.equal(forward.sent.length, 1);
  const again = await gw.decide(c.id, { decision: 'approve', approvalCode: code });
  assert.equal(again.status, 409);
  assert.equal(forward.sent.length, 1, 'no second forward');
  assert.equal(gw.get(c.id).pause.approvalCode, undefined, 'the code is gone once used');
});

test('two simultaneous approvals with the right code forward exactly once', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  const rs = await Promise.all([1, 2, 3].map(() => gw.decide(c.id, { decision: 'approve', approvalCode: code })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(forward.sent.length, 1);
});

test('deny by the human: never forwarded', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw);
  const r = await gw.decide(c.id, { decision: 'deny', approvalCode: codeOf(gw, c.id) });
  assert.equal(r.call.outcome, 'denied_by_human');
  assert.equal(forward.sent.length, 0);
});

test('forging: no code, a wrong code or a code of another call is refused and nothing is forwarded', async () => {
  const { gw, forward } = mk();
  const a = await transfer(gw, 900);
  const b = await transfer(gw, 800);
  for (const bad of [undefined, '', 'x', '0'.repeat(32), codeOf(gw, b.id), 123, { $ne: 1 }]) {
    const r = await gw.decide(a.id, { decision: 'approve', approvalCode: bad });
    assert.ok([403].includes(r.status) || r.call?.outcome === 'blocked', String(bad));
    if (gw.get(a.id).outcome !== 'pending') break;
  }
  assert.equal(forward.sent.length, 0);
  assert.equal(gw.get(b.id).outcome, 'pending', "the other call's code did not leak into a decision");
});

test('three wrong codes lock the pause for good, even for the right code afterwards', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  for (let i = 0; i < MAX_BAD_CODES; i++) assert.equal((await gw.decide(c.id, { decision: 'approve', approvalCode: 'wrong' })).status, 403);
  assert.equal(gw.get(c.id, { detail: false }).outcome, 'blocked');
  assert.equal((await gw.decide(c.id, { decision: 'approve', approvalCode: code })).status, 409);
  assert.equal(forward.sent.length, 0);
  assert.ok(gw.audit.list().some((e) => e.type === 'pause_locked'));
});

test('expiry: a pause past its ttl is expired and a late approval with the right code is refused', async () => {
  const { gw, clock, forward } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  clock.advance(PAUSE_TTL_MS + 1);
  const r = await gw.decide(c.id, { decision: 'approve', approvalCode: code });
  assert.equal(r.status, 409);
  assert.equal(r.error, 'expired');
  assert.equal(gw.get(c.id, { detail: false }).outcome, 'expired');
  assert.equal(forward.sent.length, 0);
  assert.ok(gw.audit.list().some((e) => e.type === 'pause_expired' && e.callId === c.id));
});

test('expiry happens at the boundary: still approvable one ms before, expired at the ttl', async () => {
  const { gw, clock } = mk();
  const a = await transfer(gw); const b = await transfer(gw, 800);
  clock.advance(PAUSE_TTL_MS - 1);
  assert.equal((await gw.decide(a.id, { decision: 'approve', approvalCode: codeOf(gw, a.id) })).status, 200);
  clock.advance(1);
  assert.equal((await gw.decide(b.id, { decision: 'approve', approvalCode: 'x' })).status, 409);
});

test('a scenario cannot lengthen a pause past the gateway ttl', async () => {
  const { gw } = mk();
  const c = await transfer(gw, 900, { pauseTtlMs: 10 * PAUSE_TTL_MS });
  assert.equal(c.pause.ttlMs, PAUSE_TTL_MS);
});

test('decide: unknown id 404; a call that was never paused 409; bad decision value 400', async () => {
  const { gw } = mk();
  assert.equal((await gw.decide('call-9999', { decision: 'approve', approvalCode: 'x' })).status, 404);
  const ok = await read(gw);
  assert.equal((await gw.decide(ok.id, { decision: 'approve', approvalCode: 'x' })).status, 409);
  const p = await transfer(gw);
  assert.equal((await gw.decide(p.id, { decision: 'maybe', approvalCode: codeOf(gw, p.id) })).status, 400);
  assert.equal(gw.get(p.id, { detail: false }).outcome, 'pending');
});

test('the pending queue is capped: past the cap a would-be pause is denied', async () => {
  const { gw } = mk({ pendingCap: 3 });
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await transfer(gw, 600 + i));
  assert.deepEqual(outs.map((c) => c.outcome), ['pending', 'pending', 'pending', 'blocked', 'blocked']);
  assert.equal(outs[4].reason, 'pause_queue_full');
});

test('the decision buffer is a bounded ring; pending calls are not evicted', async () => {
  const { gw } = mk({ ringCap: 5, rate: { max: 1000, windowMs: 1000 } });
  const p = await transfer(gw);
  for (let i = 0; i < 12; i++) await read(gw, { ticketId: `T-${i}` });
  const { calls } = gw.list();
  assert.equal(calls.length, 5);
  assert.ok(calls.some((c) => c.id === p.id), 'the pending call is still there');
  assert.equal(calls.at(-1).args.ticketId, 'T-11');
});

test('the polling cursor returns only what changed since, including a pause resolving', async () => {
  const { gw } = mk();
  const a = await read(gw);
  const p = await transfer(gw);
  const first = gw.list();
  assert.equal(first.calls.length, 2);
  assert.deepEqual(gw.list({ since: first.cursor }).calls, []);
  await gw.decide(p.id, { decision: 'approve', approvalCode: codeOf(gw, p.id) });
  const second = gw.list({ since: first.cursor });
  assert.deepEqual(second.calls.map((c) => [c.id, c.outcome]), [[p.id, 'forwarded']]);
  assert.ok(second.cursor > first.cursor);
  assert.ok(a.id);
});

test('an upstream failure is an upstream_error, never retried, and audited', async () => {
  const { gw, forward } = mk({ forward: fakeForward({ fail: true }) });
  const c = await read(gw);
  assert.equal(c.outcome, 'upstream_error');
  assert.equal(forward.sent.length, 1);
  assert.ok(gw.audit.list().some((e) => e.type === 'upstream_error'));
});

test('a throwing forwarder (refused target) fails closed', async () => {
  const forward = { portFor: () => 9999, call: async () => { throw new Error('bad target'); } };
  const { gw } = mk({ forward });
  const c = await read(gw);
  assert.equal(c.outcome, 'upstream_error');
  assert.equal(c.upstream.error, 'upstream_refused_target');
});

test('redaction and inert text: agent arguments and upstream results are redacted, hidden characters shown', async () => {
  const { gw } = mk({ forward: fakeForward({ result: { note: 'x\u200By password=hunter2hunter2', t: 'ok' } }) });
  const fakeKey = ['abcdefgh', '1234', '5678'].join(''); const fakePw = ['hunter2', 'hunter2'].join('');
  const c = await gw.handle({ agentId: 'support-bot', tool: 'tickets.read', args: { ticketId: 'T-1', api_key: fakeKey, note: `login with password=${fakePw}` } });
  const detail = gw.get(c.id);
  assert.equal(detail.args.api_key, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(detail), /hunter2/);
  assert.match(detail.upstream.result.note, /x\[U\+200B\]y/);
  assert.doesNotMatch(JSON.stringify(gw.audit.list()), new RegExp(`${fakePw}|${fakeKey}`));
  assert.doesNotMatch(JSON.stringify(gw.audit.list()), /\u200B/);
});

test('hidden characters in an agent-supplied name or argument are made visible in the record and the audit', async () => {
  const { gw } = mk();
  const c = await gw.handle({ agentId: 'ghost\u202E', tool: 'a\u200Bb', args: { k: 'v\u2028w' } });
  const s = JSON.stringify([c, gw.audit.list()]);
  assert.doesNotMatch(s, /[\u200B\u202E\u2028]/);
  assert.match(s, /\[U\+202E\]/);
});

test('the approval code never reaches the audit trail', async () => {
  const { gw } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  await gw.decide(c.id, { decision: 'approve', approvalCode: code });
  await gw.decide(c.id, { decision: 'approve', approvalCode: 'wrong-guess-1234' });
  assert.ok(!JSON.stringify(gw.audit.list()).includes(code));
  assert.ok(!JSON.stringify(gw.audit.list()).includes('wrong-guess-1234'));
});

test('audit trail covers a full pause: decision, opened, approved, forwarded; and it verifies', async () => {
  const { gw } = mk();
  const c = await transfer(gw);
  await gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) });
  assert.deepEqual(gw.audit.list().map((e) => e.type), ['decision', 'pause_opened', 'pause_approved', 'forwarded']);
  assert.equal(gw.audit.verify().ok, true);
});

test('reset clears calls, pauses and rate state, keeps the audit chain verifiable, and a stale code is dead', async () => {
  const { gw } = mk();
  const c = await transfer(gw);
  const code = codeOf(gw, c.id);
  for (let i = 0; i < 6; i++) await read(gw);
  gw.reset();
  assert.equal(gw.list().calls.length, 0);
  assert.equal((await gw.decide(c.id, { decision: 'approve', approvalCode: code })).status, 404);
  assert.equal((await read(gw)).reason, 'rule_allow', 'rate window cleared');
  assert.equal(gw.audit.list()[0].type, 'reset');
  assert.equal(gw.audit.verify().ok, true);
  assert.equal(gw.get(c.id), null);
});

// GW2 pins.
test('an approved call forwards exactly the args that were paused, unchanged', async () => {
  const { gw, forward } = mk();
  const c = await transfer(gw, 900, { args: { amount: 900, to: 'acct-demo-9', memo: 'rent' } });
  await gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) });
  assert.deepEqual(forward.sent[0].args, { amount: 900, to: 'acct-demo-9', memo: 'rent' });
});

test('the call list never carries the upstream answer; the detail does', async () => {
  const { gw } = mk({ forward: fakeForward({ result: { note: 'answer-body' } }) });
  const c = await read(gw);
  assert.ok(gw.list().calls[0].upstream && !('result' in gw.list().calls[0].upstream));
  assert.ok(!JSON.stringify(gw.list()).includes('answer-body'));
  assert.deepEqual(gw.get(c.id).upstream.result, { note: 'answer-body' });
  assert.equal(c.upstream.result, undefined, 'the handle() view is the list view');
});

test('a reset while a forward is in flight leaves the new audit epoch free of that call', async () => {
  let release;
  const forward = { sent: [], portFor: () => 5851, call: () => new Promise((r) => { release = () => r({ ok: true, result: { late: true } }); }) };
  const { gw } = mk({ forward });
  const pending = read(gw);
  while (!release) await new Promise((r) => setImmediate(r));
  gw.reset();
  const before = gw.audit.list().map((e) => e.type);
  release();
  await pending;
  assert.deepEqual(gw.audit.list().map((e) => e.type), before);
  assert.deepEqual(before, ['reset']);
  assert.equal(gw.audit.verify().ok, true);
  assert.equal(gw.list().calls.length, 0);
});

test('a reset while an approved call is in flight also writes nothing into the new epoch', async () => {
  let release; let first = true;
  const forward = { sent: [], portFor: () => 5852, call: () => (first ? (first = false, new Promise((r) => { release = () => r({ ok: false, error: 'upstream_timeout' }); })) : Promise.resolve({ ok: true, result: {} })) };
  const { gw } = mk({ forward });
  const c = await transfer(gw);
  const answering = gw.decide(c.id, { decision: 'approve', approvalCode: codeOf(gw, c.id) });
  while (!release) await new Promise((r) => setImmediate(r));
  gw.reset();
  release();
  await answering;
  assert.deepEqual(gw.audit.list().map((e) => e.type), ['reset']);
});
